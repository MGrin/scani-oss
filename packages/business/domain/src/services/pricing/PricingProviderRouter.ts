import type { NewTokenPrice, Token } from '@scani/db/schema';
import { createComponentLogger, logger } from '@scani/logging';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { pricingCircuitBreaker } from '@scani/rate-limiter';
import { Container, Service } from 'typedi';
import { TokenPriceRepository } from '../../repositories/TokenPriceRepository';
import { TokenRepository } from '../../repositories/TokenRepository';
import { PricingFailureCacher } from './PricingFailureCacher';
import {
  PRICING_PROVIDER_REGISTRY_KEYS,
  type PricingExecutionContext,
  type PricingProvider,
  PricingProviderAdapter,
  type PricingProviderKey,
  type PricingResult,
  type RoutedToken,
} from './PricingProviderAdapter';

const routerLogger = createComponentLogger('pricing:router');

/**
 * Token-type → pricing-provider table. Adding a new token type is one
 * entry here; runtime discrimination (stock→Finnhub vs Google Sheets by
 * exchange) lives in `stockProviderFor`. `null` means "no external
 * provider — manual pricing only" (used for `private-company` and
 * `other` types).
 */
const TOKEN_TYPE_TO_PROVIDER: Record<string, PricingProviderKey | 'stock-discriminator' | null> = {
  fiat: 'exchangeRate',
  crypto: 'coinGecko',
  stock: 'stock-discriminator',
  'private-company': null,
  other: null,
};

/**
 * Exchange identifiers that Finnhub's free tier covers. Extracted so a
 * new US-listed exchange (e.g. IEX adding a new venue) is a one-line
 * config change instead of an if-chain edit.
 */
const US_EXCHANGE_IDS: ReadonlySet<string> = new Set([
  'NYSE',
  'NASDAQ',
  'ARCA',
  'AMEX',
  'BATS',
  'IEX',
  'US',
]);

type ProviderAdapterMap = Record<PricingProviderKey, PricingProvider>;

/**
 * Routes tokens to upstream pricing providers, executes batched
 * fetches with circuit-breaker protection, applies the
 * CoinGecko→DeFiLlama and Finnhub→Google Sheets fallback chains, and
 * persists successful results to the token-price cache.
 */
@Service()
export class PricingProviderRouter {
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly tokenPriceRepository = Container.get(TokenPriceRepository);
  private readonly failureCacher = Container.get(PricingFailureCacher);

  private readonly providers: ProviderAdapterMap;
  private readonly googleSheetsAvailable: boolean;

  constructor() {
    // Pull pricing providers from the unified `@scani/providers`
    // registry. Cloud-vs-direct dispatch is settled at app boot
    // (`buildProviderRegistry({ mode })`); by the time this router
    // runs, the registry already holds the right instances and the
    // adapter bridges the per-token capability methods to the batch
    // orchestration this router exposes.
    //
    // GoogleSheets is registered separately by backend / worker boot
    // (it lives in `@scani/providers-google-sheets` and reads per-user
    // sheet config from the DB). data-provider intentionally skips it.
    const registry = Container.get(ProviderRegistry);
    const allCurrent = registry.getAllCurrentPricers();
    const findByKey = (newKey: string) => allCurrent.find((p) => p.providerKey === newKey);

    const buildAdapter = (pricingKey: PricingProviderKey): PricingProvider => {
      const newKey = PRICING_PROVIDER_REGISTRY_KEYS[pricingKey];
      const provider = newKey ? findByKey(newKey) : undefined;
      if (!provider) {
        // Boot order is registry → router. A missing provider usually
        // means the app didn't include the corresponding factory in
        // `buildProviderRegistry({ providers: [...] })`, OR a test
        // instantiates the router transitively without seeding a
        // registry. We log loudly but degrade to an empty-result
        // adapter so unrelated paths keep working — every pricing
        // call against this key returns price='0' with a recognizable
        // source tag.
        routerLogger.warn(
          { pricingKey, newKey },
          `PricingProviderRouter: no provider registered with key '${newKey}' — pricing requests for this provider will return zero results`
        );
        return {
          key: pricingKey,
          fetchPrices: async (tokens) =>
            tokens.map((t) => ({
              tokenId: t.token.id,
              price: '0',
              timestamp: new Date(),
              source: `${pricingKey}_no_provider`,
            })),
        };
      }
      return new PricingProviderAdapter(pricingKey, provider);
    };

    this.providers = {
      exchangeRate: buildAdapter('exchangeRate'),
      coinGecko: buildAdapter('coinGecko'),
      defiLlama: buildAdapter('defiLlama'),
      finnhub: buildAdapter('finnhub'),
      googleSheets: buildAdapter('googleSheets'),
    };

    const gsKey = PRICING_PROVIDER_REGISTRY_KEYS.googleSheets;
    this.googleSheetsAvailable = Boolean(gsKey && findByKey(gsKey));
  }

  async routeAndFetch(
    tokens: Token[],
    baseCurrencyToken: Token,
    timestamp: Date
  ): Promise<PricingResult[]> {
    if (tokens.length === 0) return [];
    const tokensByProvider = await this.groupTokensByProvider(tokens);
    return await this.fetchFromAllProviders(tokensByProvider, baseCurrencyToken, timestamp);
  }

  async canTokenBePriced(
    tokenData: {
      symbol: string;
      name: string;
      metadata: Record<string, unknown>;
      typeCode: string;
    },
    baseCurrency = 'USD'
  ): Promise<{ canBePriced: boolean; provider?: string; reason?: string }> {
    if (tokenData.typeCode.toLowerCase() !== 'crypto') {
      return {
        canBePriced: true,
        provider: 'other',
        reason: 'Non-crypto token type',
      };
    }

    try {
      const baseCurrencyToken = await this.tokenRepository.findBySymbol(baseCurrency);
      if (!baseCurrencyToken) {
        logger.warn({ baseCurrency }, 'Base currency token not found in validation');
        return { canBePriced: false, reason: 'Base currency not found' };
      }

      const context: PricingExecutionContext = {
        baseCurrency: baseCurrencyToken,
        timestamp: new Date(),
      };

      const tempToken = (providerTokenId: string, provider: PricingProviderKey): RoutedToken => ({
        token: {
          id: 'temp-validation-id',
          symbol: tokenData.symbol,
          name: tokenData.name,
          typeId: 'temp',
          decimals: 18,
          iconUrl: null,
          marketSegment: null,
          providerMetadata: tokenData.metadata,
          isScamProbability: 0,
          isActive: true,
          unpriceableUntil: null,
          lastPricingAttemptAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        provider,
        providerTokenId,
      });

      const coinGeckoId =
        (tokenData.metadata.coingecko as { id?: string })?.id || tokenData.symbol.toLowerCase();
      const coinGeckoProvider = this.providers.coinGecko;

      if (coinGeckoProvider) {
        try {
          const coinGeckoResults = await coinGeckoProvider.fetchPrices(
            [tempToken(coinGeckoId, 'coinGecko')],
            context
          );
          const r = coinGeckoResults[0];
          if (r && r.price !== '0' && !r.source?.includes('empty')) {
            return {
              canBePriced: true,
              provider: 'CoinGecko',
              reason: 'Found on CoinGecko',
            };
          }
        } catch (error) {
          logger.debug(
            { error, symbol: tokenData.symbol },
            'CoinGecko validation failed, trying DeFiLlama'
          );
        }
      }

      const contractAddress = tokenData.metadata.contractAddress as string | undefined;
      const chainId = tokenData.metadata.chainId as number | undefined;

      if (contractAddress && chainId) {
        const defiLlamaProvider = this.providers.defiLlama;
        if (defiLlamaProvider) {
          try {
            const defiLlamaResults = await defiLlamaProvider.fetchPrices(
              [tempToken(`${chainId}:${contractAddress}`, 'defiLlama')],
              context
            );
            const r = defiLlamaResults[0];
            if (r && r.price !== '0' && !r.source?.includes('empty')) {
              return {
                canBePriced: true,
                provider: 'DeFiLlama',
                reason: 'Found on DeFiLlama',
              };
            }
          } catch (error) {
            logger.debug({ error, symbol: tokenData.symbol }, 'DeFiLlama validation failed');
          }
        }
      }

      return {
        canBePriced: false,
        reason: 'Not found on CoinGecko or DeFiLlama',
      };
    } catch (error) {
      logger.error({ error, symbol: tokenData.symbol }, 'Token pricing validation failed');
      return { canBePriced: false, reason: 'Validation error' };
    }
  }

  private async groupTokensByProvider(
    tokensToGroup: Token[]
  ): Promise<Map<PricingProviderKey, RoutedToken[]>> {
    const groupedTokens = new Map<PricingProviderKey, RoutedToken[]>();

    if (tokensToGroup.length === 0) return groupedTokens;

    const tokenIds = tokensToGroup.map((t) => t.id);
    const tokensWithTypeData = await this.tokenRepository.findManyWithTypes(tokenIds);

    const tokenTypeMap = new Map<string, string | null>();
    for (const t of tokensWithTypeData) {
      tokenTypeMap.set(t.id, t.typeCode);
    }

    const tokensWithType = tokensToGroup.map((token) => ({
      token,
      typeCode: tokenTypeMap.get(token.id) || null,
    }));

    for (const { token, typeCode } of tokensWithType) {
      if (!typeCode) continue;

      let provider: PricingProviderKey | null = null;
      let providerTokenId: string | undefined;

      try {
        // `providerMetadata` is jsonb-typed; the type signature is
        // `TokenMetadata | string` because some write paths still
        // stringify the blob. Normalize either form into an object
        // so the rest of the function can use dotted-property access.
        const rawMeta = token.providerMetadata ?? {};
        const metadata = (
          typeof rawMeta === 'string'
            ? (JSON.parse(rawMeta) as Record<string, unknown>)
            : (rawMeta as Record<string, unknown>)
        ) as Record<string, unknown> & {
          finnhub?: { symbol?: string };
          coingecko?: { id?: string };
          coinGeckoId?: string;
        };

        // Order matters here: prefer CoinGecko/DeFiLlama for any
        // crypto-typed token, even when the metadata also carries a
        // `finnhub.symbol`. Kraken-imported holdings (BTC, ETH, USDC,
        // USDT, …) get a `finnhub.symbol` stamped during enrichment,
        // but Finnhub's free tier only prices US equities — the
        // crypto symbols silently return empty and the entire
        // exchange portfolio shows up unpriced. Finnhub stays the
        // primary for stock-typed tokens (its actual coverage area).
        const isCryptoLike = typeCode.toLowerCase() === 'crypto';

        if (!isCryptoLike && metadata.finnhub?.symbol) {
          // Non-US Finnhub listings can't be priced by the free tier —
          // route them to Google Sheets (GOOGLEFINANCE). US listings and
          // anything without exchangeInfo stay on Finnhub.
          const finnhubExchangeInfo = metadata.exchangeInfo as
            | { exchange?: string; currency?: string }
            | undefined;
          if (
            finnhubExchangeInfo &&
            !this.isUSExchange(finnhubExchangeInfo) &&
            typeCode.toLowerCase() === 'stock'
          ) {
            provider = 'googleSheets';
            providerTokenId = metadata.finnhub.symbol;
            logger.info(
              {
                tokenId: token.id,
                symbol: token.symbol,
                typeCode,
                finnhubSymbol: metadata.finnhub.symbol,
                exchange: finnhubExchangeInfo.exchange,
                currency: finnhubExchangeInfo.currency,
              },
              'Routing non-US Finnhub stock to Google Sheets (free-tier limitation)'
            );
          } else {
            provider = 'finnhub';
            providerTokenId = metadata.finnhub.symbol;
            logger.info(
              {
                tokenId: token.id,
                symbol: token.symbol,
                typeCode,
                finnhubSymbol: metadata.finnhub.symbol,
              },
              'Assigning token to Finnhub based on provider metadata (overriding type-based assignment)'
            );
          }
        } else if (metadata.coingecko?.id || metadata.coinGeckoId) {
          provider = 'coinGecko';
          providerTokenId = metadata.coingecko?.id || metadata.coinGeckoId;
          logger.debug(
            {
              tokenId: token.id,
              symbol: token.symbol,
              typeCode,
              coinGeckoId: providerTokenId,
            },
            'Assigning token to CoinGecko based on provider metadata (overriding type-based assignment)'
          );
        } else if (typeCode.toLowerCase() === 'crypto') {
          // Crypto tokens: try CoinGecko first (primary). DeFiLlama is
          // the fallback when CoinGecko returns empty/error and the
          // token has a contractAddress + chainId.
          provider = 'coinGecko';
          providerTokenId = this.getProviderTokenId(provider, token, metadata);
          logger.debug(
            {
              tokenId: token.id,
              symbol: token.symbol,
              typeCode,
              hasContractAddress: !!metadata.contractAddress,
              chainId: metadata.chainId,
            },
            'Assigning crypto token to CoinGecko (primary provider) - DeFiLlama fallback available'
          );
        } else {
          provider = this.getProviderByTokenType(typeCode, token, metadata);
          providerTokenId = this.getProviderTokenId(provider, token, metadata);
        }
      } catch (error) {
        logger.warn(
          {
            tokenId: token.id,
            symbol: token.symbol,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to parse provider metadata, using type-based provider assignment'
        );
        provider = this.getProviderByTokenType(typeCode, token);
        providerTokenId = this.getProviderTokenId(provider, token, {});
      }

      if (!provider) continue;

      if (!groupedTokens.has(provider)) {
        groupedTokens.set(provider, []);
      }

      groupedTokens.get(provider)!.push({
        token,
        provider,
        providerTokenId,
      });
    }

    const summary = Object.fromEntries(
      Array.from(groupedTokens.entries()).map(([k, v]) => [k, v.length])
    );
    logger.info(
      { providerAssignments: summary, totalTokens: tokensWithType.length },
      'Tokens grouped by pricing provider'
    );

    return groupedTokens;
  }

  private getProviderByTokenType(
    typeCode: string,
    token: Token,
    metadata?: Record<string, unknown>
  ): PricingProviderKey | null {
    const entry = TOKEN_TYPE_TO_PROVIDER[typeCode.toLowerCase()];
    if (entry === undefined) {
      logger.warn(
        {
          tokenId: token.id,
          symbol: token.symbol,
          typeCode,
        },
        'Unknown token type, skipping provider assignment'
      );
      return null;
    }
    if (entry === null) return null;
    if (entry === 'stock-discriminator') return this.stockProviderFor(metadata);
    return entry;
  }

  // Finnhub's free tier covers US exchanges only, so non-US listings
  // are routed to Google Sheets (GOOGLEFINANCE). Listings without an
  // exchange hint fall through to Finnhub — if that fails, the cache
  // sees source='Finnhub' price=0 and a retry kicks Google Sheets in.
  private stockProviderFor(metadata?: Record<string, unknown>): PricingProviderKey {
    const exchangeInfo = metadata?.exchangeInfo as
      | { exchange?: string; currency?: string }
      | undefined;
    if (exchangeInfo && !this.isUSExchange(exchangeInfo)) {
      return 'googleSheets';
    }
    return 'finnhub';
  }

  private isUSExchange(exchangeInfo: { exchange?: string; currency?: string }): boolean {
    if (exchangeInfo.currency === 'USD') return true;
    const exchange = (exchangeInfo.exchange || '').toUpperCase();
    return US_EXCHANGE_IDS.has(exchange);
  }

  private getProviderTokenId(
    provider: PricingProviderKey | null,
    token: Token,
    metadata: Record<string, unknown>
  ): string | undefined {
    if (!provider) return undefined;

    switch (provider) {
      case 'exchangeRate':
        return token.symbol;
      case 'coinGecko': {
        const coinGeckoData = metadata.coingecko as { id?: string } | undefined;
        const coinGeckoId = metadata.coinGeckoId as string | undefined;
        return coinGeckoData?.id || coinGeckoId || token.symbol.toLowerCase();
      }
      case 'defiLlama': {
        // DeFiLlama format: "chainId:contractAddress".
        const contractAddress = metadata.contractAddress as string | undefined;
        const chainId = metadata.chainId as number | undefined;
        if (contractAddress && chainId) {
          return `${chainId}:${contractAddress}`;
        }
        return undefined;
      }
      case 'finnhub': {
        const finnhubData = metadata.finnhub as { symbol?: string } | undefined;
        return finnhubData?.symbol || token.symbol;
      }
      default:
        return token.symbol;
    }
  }

  private async fetchFromAllProviders(
    tokensByProvider: Map<PricingProviderKey, RoutedToken[]>,
    baseCurrencyToken: Token,
    timestamp: Date
  ): Promise<PricingResult[]> {
    const context: PricingExecutionContext = {
      baseCurrency: baseCurrencyToken,
      timestamp,
    };

    const allResults: PricingResult[] = [];

    // Primary fallback chain — googleSheets is handled separately
    // below as it's a stock-only specialist that gets its own
    // routing via groupTokensByProvider.
    const primaryProviders: Exclude<PricingProviderKey, 'googleSheets'>[] = [
      'exchangeRate',
      'coinGecko',
      'finnhub',
      'defiLlama',
    ];

    const providerPromises = primaryProviders.map(async (providerKey) => {
      const tokensForProvider = tokensByProvider.get(providerKey);
      if (!tokensForProvider || tokensForProvider.length === 0) {
        return [] as PricingResult[];
      }

      const provider = this.providers[providerKey];
      if (!provider) {
        return [] as PricingResult[];
      }

      if (!pricingCircuitBreaker.isAvailable(providerKey)) {
        logger.warn({ provider: providerKey }, 'Provider circuit open — skipping');
        return tokensForProvider.map(({ token }) =>
          this.failureCacher.cacheFailure(
            token.id,
            timestamp,
            provider.key,
            new Error('circuit open')
          )
        );
      }

      try {
        const results = await provider.fetchPrices(tokensForProvider, context);
        pricingCircuitBreaker.recordSuccess(providerKey);
        return results;
      } catch (error) {
        pricingCircuitBreaker.recordFailure(providerKey);
        logger.error({ error, provider: providerKey }, 'Provider fetch failed');
        return tokensForProvider.map(({ token }) =>
          this.failureCacher.cacheFailure(token.id, timestamp, provider.key, error)
        );
      }
    });

    // Google Sheets as primary provider for non-US stocks (routed by groupTokensByProvider).
    const googleSheetsPrimaryTokens = tokensByProvider.get('googleSheets');
    if (
      googleSheetsPrimaryTokens &&
      googleSheetsPrimaryTokens.length > 0 &&
      this.googleSheetsAvailable
    ) {
      providerPromises.push(
        (async () => {
          try {
            logger.info(
              { tokenCount: googleSheetsPrimaryTokens.length },
              'Fetching non-US stock prices from Google Sheets (primary provider)'
            );
            return await this.providers.googleSheets.fetchPrices(
              googleSheetsPrimaryTokens,
              context
            );
          } catch (error) {
            logger.error({ error }, 'Google Sheets primary provider fetch failed');
            return [] as PricingResult[];
          }
        })()
      );
    }

    const providerResults = await Promise.all(providerPromises);
    for (const results of providerResults) {
      allResults.push(...results);
    }

    // DeFiLlama fallback for crypto tokens that failed CoinGecko. The
    // post-refactor identity layer stores chain+contract under the
    // `etherscan` namespace (`metadata.etherscan.{chainId,
    // contractAddress}`); legacy rows kept the flat keys
    // (`metadata.{chainId, contractAddress}`). Read both. The CoinGecko
    // adapter emits failure rows as `${this.key}_no_data` /
    // `${this.key}_error_*` where `this.key` is `'coinGecko'`
    // (camelCase) — case-insensitive prefix match keeps us robust to
    // future rename.
    const tokensNeedingDeFiLlamaFallback: RoutedToken[] = [];

    for (const [providerKey, tokensForProvider] of tokensByProvider.entries()) {
      if (providerKey !== 'coinGecko') continue;
      for (const tokenWithProvider of tokensForProvider) {
        try {
          const metadata = (tokenWithProvider.token.providerMetadata ?? {}) as Record<
            string,
            unknown
          >;
          const etherscan = (metadata.etherscan ?? null) as {
            chainId?: number | string;
            contractAddress?: string;
          } | null;
          const solana = (metadata.solana ?? null) as { mint?: string } | null;
          const chainId = etherscan?.chainId ?? (metadata.chainId as number | string | undefined);
          const contractAddress =
            etherscan?.contractAddress ?? (metadata.contractAddress as string | undefined);
          // Trigger fallback for any token DeFiLlama can derive a coin
          // key for: (chain, contract) for EVM, (mint) for Solana SPL.
          // Without the Solana branch, every SPL token CoinGecko
          // doesn't index ends up unpriced and the chart renders the
          // wallet's whole history as a dashed-line "partial coverage"
          // band.
          const hasEvmIdentity = Boolean(chainId && contractAddress);
          const hasSolanaIdentity = Boolean(solana?.mint);
          if (!hasEvmIdentity && !hasSolanaIdentity) continue;

          const coinGeckoResult = allResults.find(
            (r) =>
              r.tokenId === tokenWithProvider.token.id &&
              r.source?.toLowerCase().startsWith('coingecko')
          );
          // Trigger fallback when we have a failure marker (no_data /
          // error_* / empty_response) OR when CoinGecko didn't produce
          // any row at all (defensive — shouldn't happen given the
          // adapter always emits a row, but covers exotic provider
          // wiring).
          const coinGeckoFailed =
            !coinGeckoResult ||
            coinGeckoResult.price === '0' ||
            coinGeckoResult.source?.includes('_no_data') === true ||
            coinGeckoResult.source?.includes('_error') === true ||
            coinGeckoResult.source?.includes('empty') === true;
          if (!coinGeckoFailed) continue;

          // providerTokenId is a label only; DeFiLlama's adapter pulls
          // the actual coin key from token.providerMetadata via
          // `coinKey()` (which now handles `solana:<mint>` too).
          const providerTokenId = hasEvmIdentity
            ? `${chainId}:${contractAddress}`
            : `solana:${solana?.mint}`;
          tokensNeedingDeFiLlamaFallback.push({
            token: tokenWithProvider.token,
            provider: 'defiLlama',
            providerTokenId,
          });

          logger.debug(
            {
              tokenId: tokenWithProvider.token.id,
              symbol: tokenWithProvider.token.symbol,
              contractAddress,
              chainId,
            },
            'CoinGecko failed, falling back to DeFiLlama for token with contract address'
          );
        } catch (_error) {
          // Per-token metadata parsing is best-effort.
        }
      }
    }

    if (tokensNeedingDeFiLlamaFallback.length > 0) {
      const defiLlamaProvider = this.providers.defiLlama;
      if (defiLlamaProvider) {
        try {
          logger.info(
            {
              count: tokensNeedingDeFiLlamaFallback.length,
              symbols: tokensNeedingDeFiLlamaFallback.map((t) => t.token.symbol).slice(0, 10),
            },
            'CoinGecko→DeFiLlama fallback triggered'
          );

          const defiLlamaResults = await defiLlamaProvider.fetchPrices(
            tokensNeedingDeFiLlamaFallback,
            context
          );

          for (const defiLlamaResult of defiLlamaResults) {
            const existingIndex = allResults.findIndex(
              (r) => r.tokenId === defiLlamaResult.tokenId
            );
            if (existingIndex !== -1) {
              allResults.splice(existingIndex, 1);
            }
            allResults.push(defiLlamaResult);
          }
        } catch (error) {
          logger.error({ error }, 'DeFiLlama fallback failed');
        }
      }
    }

    const allTokens = Array.from(tokensByProvider.values()).flat();
    const tokensStillNeedingPrices = allTokens.filter((tokenWithProvider) => {
      const hasSuccessfulPrice = allResults.some(
        (result) => result.tokenId === tokenWithProvider.token.id && result.price !== '0'
      );
      if (hasSuccessfulPrice) {
        return false;
      }
      return this.isEligibleForSheetsByFailure(allResults, tokenWithProvider.token.id);
    });

    logger.info(
      {
        totalTokens: allTokens.length,
        tokensWithResults: allResults.length,
        tokensStillNeeding: tokensStillNeedingPrices.length,
        googleSheetsAvailable: this.googleSheetsAvailable,
        resultsBreakdown: allResults.map((r) => ({
          tokenId: r.tokenId,
          price: r.price,
          source: r.source,
        })),
      },
      'Checking tokens for Google Sheets fallback'
    );

    if (tokensStillNeedingPrices.length > 0 && this.googleSheetsAvailable) {
      const tokenMap = new Map<string, Token>();
      for (const { token } of tokensStillNeedingPrices) {
        tokenMap.set(token.id, token);
      }

      const eligibleTokens = await this.filterTokensEligibleForGoogleSheets(
        Array.from(tokenMap.values())
      );

      if (eligibleTokens.length > 0) {
        const googleTokens: RoutedToken[] = eligibleTokens.map((token) => ({
          token,
          provider: 'googleSheets',
        }));

        try {
          const googleResults = await this.providers.googleSheets.fetchPrices(
            googleTokens,
            context
          );

          for (const result of googleResults) {
            const existingIndex = allResults.findIndex((r) => r.tokenId === result.tokenId);
            if (existingIndex !== -1) {
              allResults.splice(existingIndex, 1);
            }
            allResults.push(result);
          }
        } catch (error) {
          logger.warn({ error }, 'Google Sheets fallback failed');
        }
      } else {
        logger.debug(
          { totalTokens: tokensStillNeedingPrices.length },
          'No tokens eligible for Google Sheets fallback'
        );
      }
    }

    await this.cachePriceResults(allResults, baseCurrencyToken.id);

    return allResults;
  }

  private isEligibleForSheetsByFailure(existingResults: PricingResult[], tokenId: string): boolean {
    for (let i = existingResults.length - 1; i >= 0; i--) {
      const r = existingResults[i];
      if (!r) continue;
      if (r.tokenId !== tokenId) continue;
      if (r.price !== '0') return false;

      const source = (r.source ?? '').toLowerCase();
      if (
        source.includes('tier_limitation') ||
        source.includes('unauthorized_access') ||
        source.includes('unavailable') ||
        source.includes('empty_response')
      ) {
        return true;
      }
      if (source.includes('network_error') || source.includes('retryable_error')) {
        return false;
      }
      return false;
    }
    return false;
  }

  // Pre-F3 this lived on `GoogleSheetsProvider.filterEligibleTokens` —
  // moved here when the provider became registry-backed so the router
  // doesn't need to reach back through the registry to a concrete
  // class shape just for this filter.
  private async filterTokensEligibleForGoogleSheets(tokens: Token[]): Promise<Token[]> {
    if (tokens.length === 0) return [];
    const withTypes = await this.tokenRepository.findManyWithTypes(tokens.map((t) => t.id));
    const typeByTokenId = new Map<string, string | null>();
    for (const row of withTypes) {
      typeByTokenId.set(row.id, row.typeCode);
    }
    return tokens.filter((token) => {
      const typeCode = typeByTokenId.get(token.id) ?? null;
      // Stock-shaped tokens are always eligible (Google Sheets covers
      // Stock/ETF/Equity/Commodity).
      if (typeCode && typeCode.toLowerCase() === 'stock') return true;
      // Non-stock tokens with a Finnhub symbol can still go through
      // GOOGLEFINANCE — the discriminator routed them to Finnhub for
      // some other reason and we're falling back here.
      try {
        const metadata = (
          typeof token.providerMetadata === 'string'
            ? JSON.parse(token.providerMetadata)
            : (token.providerMetadata ?? {})
        ) as { finnhub?: { symbol?: string } };
        return Boolean(metadata.finnhub?.symbol);
      } catch {
        return false;
      }
    });
  }

  private async cachePriceResults(results: PricingResult[], baseCurrencyId: string): Promise<void> {
    if (results.length === 0) return;

    logger.debug(
      {
        resultCount: results.length,
        sources: results.map((r) => r.source),
        baseCurrencyId,
      },
      'Caching price results to database'
    );

    // Zero prices indicate failures and must never be persisted; the
    // failure-cacher already stamped a recognizable source tag on
    // them so the upstream router can decide whether to retry.
    const validPriceResults = results.filter((result) => {
      const price = parseFloat(result.price);
      if (price === 0 || Number.isNaN(price)) {
        logger.debug(
          {
            tokenId: result.tokenId,
            price: result.price,
            source: result.source,
          },
          'Skipping cache of zero/invalid price - failures should not be persisted'
        );
        return false;
      }
      return true;
    });

    if (validPriceResults.length === 0) {
      logger.debug('No valid prices to cache after filtering out zeros');
      return;
    }

    const priceRecords: NewTokenPrice[] = validPriceResults.map((result) => ({
      tokenId: result.tokenId,
      baseTokenId: baseCurrencyId,
      price: result.price,
      timestamp: result.timestamp,
      source: result.source,
    }));

    logger.debug(
      {
        priceRecords: priceRecords.map((p) => ({
          tokenId: p.tokenId,
          price: p.price,
          source: p.source,
          timestamp: p.timestamp.toISOString(),
        })),
        filteredOut: results.length - validPriceResults.length,
      },
      'Price records to be cached (after filtering)'
    );

    try {
      await this.tokenPriceRepository.bulkUpsert(priceRecords);
      logger.debug(
        { cachedCount: priceRecords.length },
        'Successfully cached price results to database'
      );
    } catch (error) {
      logger.error({ error, priceRecords }, 'Failed to cache price results');
    }
  }
}
