import { Container, Service } from 'typedi';
import { db } from '../database/connection';
import type { NewTokenPrice, Token } from '../domain/entities';
import { PROVIDER_CONFIGS } from '../external-services/pricing/provider-config';
import type {
  ConvertPriceFn,
  PricingProvider,
  ProviderExecutionContext,
} from '../external-services/pricing/providers/base';
import { CoinGeckoProvider } from '../external-services/pricing/providers/coingecko';
import { DeFiLlamaProvider } from '../external-services/pricing/providers/defillama';
import { ExchangeRateProvider } from '../external-services/pricing/providers/exchange-rate';
import { FinnhubProvider } from '../external-services/pricing/providers/finnhub';
import { GoogleSheetsProvider } from '../external-services/pricing/providers/google-sheets';
import type {
  PricingProviderKey,
  ProviderPriceResult,
  TokenWithProvider,
} from '../external-services/pricing/types';
import { fetchWithTimeout, RateLimiter } from '../external-services/pricing/utils';
import { TokenTypeRepository } from '../repositories/EnumRepositories';
import { TokenPriceRepository } from '../repositories/TokenPriceRepository';
import { TokenRepository } from '../repositories/TokenRepository';
import { createComponentLogger, logger } from '../utils/logger';

const pricingLogger = createComponentLogger('pricing');

type PrimaryProviderKey = Exclude<PricingProviderKey, 'googleSheets'>;

type ProviderRegistry = Record<PrimaryProviderKey, PricingProvider>;

interface CachedPrice {
  price: string;
  timestamp: Date;
  source: string;
  baseTokenId: string;
}

// HIGH PRIORITY FIX: Global rate limiters (singleton pattern)
// This ensures all PricingService instances share the same rate limiters
// Prevents exceeding API provider limits when multiple instances exist
const GLOBAL_RATE_LIMITERS = {
  finnhub: new RateLimiter(50, 60 * 1000), // 50 calls per minute
  // CoinGecko Demo/Public API: ~30 calls/min, use 10 for safety under ANY load
  // Reference: https://docs.coingecko.com/docs/common-errors-rate-limit
  coinGecko: new RateLimiter(10, 60 * 1000), // 10 calls per minute
  // DeFiLlama: Free tier, 5 calls/sec = 300 calls/min
  defiLlama: new RateLimiter(5, 1000), // 5 calls per second
  googleSheets: new RateLimiter(100, 100 * 1000), // 100 calls per 100 seconds
};

@Service()
export class PricingService {
  private readonly LIVE_PRICE_WINDOW_MS = 60 * 60 * 1000;
  private readonly HISTORICAL_PRICE_WINDOW_MS = 24 * 60 * 60 * 1000;
  private readonly UNAVAILABLE_CACHE_MS = 60 * 60 * 1000;
  private readonly RETRYABLE_FAILURE_CACHE_MS = 5 * 60 * 1000;

  // Use global rate limiters to prevent exceeding API limits across instances
  public readonly finnhubRateLimiter = GLOBAL_RATE_LIMITERS.finnhub;
  public readonly coinGeckoRateLimiter = GLOBAL_RATE_LIMITERS.coinGecko;
  private readonly defiLlamaRateLimiter = GLOBAL_RATE_LIMITERS.defiLlama;
  private readonly googleSheetsRateLimiter = GLOBAL_RATE_LIMITERS.googleSheets;

  private readonly providers: ProviderRegistry;
  private readonly googleSheetsProvider: GoogleSheetsProvider;
  private readonly googleSheetsAvailable: boolean;

  private readonly ongoingRequests = new Map<string, Promise<Map<string, string>>>();
  private readonly currencyRateCache = new Map<string, { rate: string; expiresAt: number }>();
  private readonly CURRENCY_CONVERSION_TTL_MS = 10 * 60 * 1000;

  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly tokenPriceRepository = Container.get(TokenPriceRepository);
  readonly _tokenTypeRepository = Container.get(TokenTypeRepository);

  constructor() {
    const createFailureResultBound = this.createFailureResult.bind(this);
    const convertPriceBound: ConvertPriceFn = this.convertPrice.bind(this);

    this.providers = {
      exchangeRate: new ExchangeRateProvider({
        createFailureResult: createFailureResultBound,
      }),
      coinGecko: new CoinGeckoProvider({
        rateLimiter: this.coinGeckoRateLimiter,
        convertPrice: convertPriceBound,
        createFailureResult: createFailureResultBound,
      }),
      defiLlama: new DeFiLlamaProvider({
        rateLimiter: this.defiLlamaRateLimiter,
        convertPrice: convertPriceBound,
        createFailureResult: createFailureResultBound,
      }),
      finnhub: new FinnhubProvider({
        rateLimiter: this.finnhubRateLimiter,
        convertPrice: convertPriceBound,
        createFailureResult: createFailureResultBound,
        logger: createComponentLogger('pricing:finnhub'),
      }),
    } satisfies ProviderRegistry;

    this.googleSheetsProvider = new GoogleSheetsProvider({
      db: db,
      rateLimiter: this.googleSheetsRateLimiter,
      finnhubRateLimiter: this.finnhubRateLimiter,
      convertPrice: convertPriceBound,
      createFailureResult: createFailureResultBound,
      logger: createComponentLogger('pricing:googleSheets'),
    });

    this.googleSheetsAvailable = this.googleSheetsProvider.isAvailable();
  }

  async getTokenPrice(token: Token, baseCurrencySymbol: string, timestamp: Date): Promise<string> {
    const baseCurrencyToken = await this.tokenRepository.findBySymbol(baseCurrencySymbol);
    if (!baseCurrencyToken) {
      pricingLogger.debug({ baseCurrencySymbol }, 'Base currency token not found in getTokenPrice');
      return '0';
    }

    if (token.id === baseCurrencyToken.id) {
      return '1';
    }

    const cached = await this.getCachedPrice(token.id, baseCurrencyToken.id, timestamp);

    if (cached && cached.price !== '0') {
      // Check if currency conversion is needed
      if (cached.baseTokenId !== baseCurrencyToken.id) {
        // Get the token for the cached price's base currency
        const cachedBaseCurrencyToken = await this.tokenRepository.findById(cached.baseTokenId);

        if (cachedBaseCurrencyToken) {
          pricingLogger.debug(
            {
              tokenId: token.id,
              symbol: token.symbol,
              fromCurrency: cachedBaseCurrencyToken.symbol,
              toCurrency: baseCurrencyToken.symbol,
              originalPrice: cached.price,
            },
            'Converting cached price to requested base currency'
          );

          const convertedPrice = await this.convertPrice(
            cached.price,
            cachedBaseCurrencyToken.symbol,
            baseCurrencyToken.symbol,
            timestamp
          );

          return convertedPrice;
        }
      }

      return cached.price;
    }

    const hasFailedFinnhubCache =
      cached && cached.price === '0' && cached.source?.includes('Finnhub');
    const hasFinnhubMetadata = this.tokenHasFinnhubMetadata(token);

    if (hasFailedFinnhubCache && hasFinnhubMetadata && this.googleSheetsAvailable) {
      pricingLogger.debug(
        {
          tokenId: token.id,
          symbol: token.symbol,
          cachedSource: cached.source,
        },
        'Token has failed Finnhub cache but Finnhub metadata - forcing fresh fetch with Google Sheets fallback'
      );
    }

    const tokensByProvider = await this.groupTokensByProvider([token]);
    const freshPrices = await this.fetchFromAllProviders(
      tokensByProvider,
      baseCurrencyToken,
      timestamp
    );

    const priceResult = freshPrices.find((p) => p.tokenId === token.id);
    let finalPrice = priceResult?.price || '0';

    // If fresh fetch failed (price is '0'), try to use the last successful cached price as fallback
    if (finalPrice === '0') {
      const lastSuccessfulPrice = await this.getLastSuccessfulPrice(token.id, baseCurrencyToken.id);

      if (lastSuccessfulPrice) {
        finalPrice = await this.convertCachedPriceIfNeeded(
          lastSuccessfulPrice,
          baseCurrencyToken.id,
          timestamp,
          undefined,
          baseCurrencyToken
        );

        pricingLogger.info(
          {
            tokenId: token.id,
            symbol: token.symbol,
            fallbackPrice: finalPrice,
            fallbackSource: lastSuccessfulPrice.source,
            originalTimestamp: lastSuccessfulPrice.timestamp,
          },
          'Using last successful price as fallback after all providers failed'
        );
      } else if (hasFinnhubMetadata) {
        logger.warn(
          { tokenId: token.id, symbol: token.symbol },
          'Token with Finnhub metadata still has no price after fresh fetch - check Google Sheets configuration'
        );
      }
    }

    return finalPrice;
  }

  async getTokenPrices(
    tokensToPrice: Token[],
    baseCurrencySymbol: string,
    timestamp: Date
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();

    if (tokensToPrice.length === 0) return results;

    const tokenIds = tokensToPrice
      .map((t) => t.id)
      .sort()
      .join(',');
    const timestampMinute = Math.floor(timestamp.getTime() / (60 * 1000)) * 60 * 1000;
    const deduplicationKey = `getTokenPrices:${tokenIds}:${baseCurrencySymbol}:${timestampMinute}`;

    const ongoingRequest = this.ongoingRequests.get(deduplicationKey);
    if (ongoingRequest) {
      logger.debug({ deduplicationKey }, 'Deduplicating concurrent getTokenPrices request');
      return await ongoingRequest;
    }

    const requestPromise = (async (): Promise<Map<string, string>> => {
      try {
        const baseCurrencyToken = await this.tokenRepository.findBySymbol(baseCurrencySymbol);
        if (!baseCurrencyToken) {
          logger.warn({ baseCurrencySymbol }, 'Base currency token not found in getTokenPrices');
          for (const token of tokensToPrice) {
            results.set(token.id, '0');
          }
          return results;
        }

        const tokensToProcess = tokensToPrice.filter((token) => {
          if (token.id === baseCurrencyToken.id) {
            results.set(token.id, '1');
            return false;
          }
          return true;
        });

        if (tokensToProcess.length === 0) return results;

        const cachedPrices = await this.getBatchCachedPrices(
          tokensToProcess.map((t) => t.id),
          baseCurrencyToken.id,
          timestamp
        );

        // PERFORMANCE FIX: Batch fetch unique base currency tokens for conversion
        const uniqueBaseCurrencyIds = new Set<string>();
        for (const cached of cachedPrices.values()) {
          if (cached.baseTokenId !== baseCurrencyToken.id) {
            uniqueBaseCurrencyIds.add(cached.baseTokenId);
          }
        }

        const baseCurrencyTokensMap = new Map<string, typeof baseCurrencyToken>();
        if (uniqueBaseCurrencyIds.size > 0) {
          const baseCurrencyTokens = await this.tokenRepository.findByIds(
            Array.from(uniqueBaseCurrencyIds)
          );
          for (const token of baseCurrencyTokens) {
            baseCurrencyTokensMap.set(token.id, token);
          }
        }

        const tokensNeedingPrices: Token[] = [];

        for (const token of tokensToProcess) {
          const cached = cachedPrices.get(token.id);
          if (cached) {
            // Check if currency conversion is needed
            if (cached.baseTokenId !== baseCurrencyToken.id) {
              const cachedBaseCurrencyToken = baseCurrencyTokensMap.get(cached.baseTokenId);

              if (cachedBaseCurrencyToken) {
                pricingLogger.debug(
                  {
                    tokenId: token.id,
                    symbol: token.symbol,
                    fromCurrency: cachedBaseCurrencyToken.symbol,
                    toCurrency: baseCurrencyToken.symbol,
                    originalPrice: cached.price,
                  },
                  'Converting cached price to requested base currency in batch'
                );

                const convertedPrice = await this.convertPrice(
                  cached.price,
                  cachedBaseCurrencyToken.symbol,
                  baseCurrencyToken.symbol,
                  timestamp
                );

                results.set(token.id, convertedPrice);
                continue;
              }
            }

            results.set(token.id, cached.price);
          } else {
            tokensNeedingPrices.push(token);
          }
        }

        if (tokensNeedingPrices.length > 0) {
          logger.info(
            {
              tokenCount: tokensNeedingPrices.length,
              cachedCount: tokensToProcess.length - tokensNeedingPrices.length,
              baseCurrency: baseCurrencySymbol,
            },
            'Fetching prices from external providers'
          );

          const tokensByProvider = await this.groupTokensByProvider(tokensNeedingPrices);

          // Retry logic for rate-limited requests
          const MAX_PROVIDER_RETRIES = 3;
          let lastError: Error | null = null;

          for (let retryAttempt = 0; retryAttempt <= MAX_PROVIDER_RETRIES; retryAttempt++) {
            try {
              const freshPrices = await this.fetchFromAllProviders(
                tokensByProvider,
                baseCurrencyToken,
                timestamp
              );

              for (const priceResult of freshPrices) {
                results.set(priceResult.tokenId, priceResult.price);
              }

              // Success - break out of retry loop
              lastError = null;
              break;
            } catch (error) {
              lastError = error instanceof Error ? error : new Error(String(error));

              // Check if this is a retryable error
              const isRetryable =
                lastError.message.includes('retryable_error') ||
                lastError.message.includes('CoinGecko retryable_error') ||
                lastError.message.includes('Finnhub retryable_error') ||
                lastError.message.includes('DeFiLlama retryable_error');

              if (!isRetryable || retryAttempt >= MAX_PROVIDER_RETRIES) {
                // Not retryable or max retries exceeded - rethrow
                throw lastError;
              }

              // Exponential backoff: 2s, 4s, 8s...
              const backoffMs = 2 ** retryAttempt * 2000;
              logger.warn(
                {
                  error: lastError.message,
                  attempt: retryAttempt + 1,
                  maxRetries: MAX_PROVIDER_RETRIES + 1,
                  backoffMs,
                },
                'Provider request failed with retryable error, retrying with backoff'
              );

              await new Promise((resolve) => setTimeout(resolve, backoffMs));
            }
          }

          // If we still have an error after all retries, it will be thrown above
          // If successful, continue with setting default prices for missing tokens

          // PERFORMANCE FIX: Batch fetch fallback prices for tokens still missing prices
          const tokensStillNeedingPrice = tokensNeedingPrices.filter(
            (t) => !results.has(t.id) || results.get(t.id) === '0'
          );

          if (tokensStillNeedingPrice.length > 0) {
            // PERFORMANCE FIX: Deduplicate token IDs before querying
            const uniqueTokenIds = Array.from(new Set(tokensStillNeedingPrice.map((t) => t.id)));
            
            const fallbackPrices = await this.tokenPriceRepository.findLatestPricesForTokens(
              uniqueTokenIds,
              baseCurrencyToken.id
            );

            // PERFORMANCE FIX: Batch fetch all unique base currency tokens for conversion
            const uniqueFallbackBaseCurrencyIds = new Set<string>();
            for (const price of fallbackPrices.values()) {
              if (price.baseTokenId !== baseCurrencyToken.id) {
                uniqueFallbackBaseCurrencyIds.add(price.baseTokenId);
              }
            }

            const fallbackBaseCurrencyTokensMap = new Map<string, typeof baseCurrencyToken>();
            if (uniqueFallbackBaseCurrencyIds.size > 0) {
              const fallbackBaseCurrencyTokens = await this.tokenRepository.findByIds(
                Array.from(uniqueFallbackBaseCurrencyIds)
              );
              for (const token of fallbackBaseCurrencyTokens) {
                fallbackBaseCurrencyTokensMap.set(token.id, token);
              }
            }

            for (const token of tokensStillNeedingPrice) {
              const latestPrice = fallbackPrices.get(token.id);

              if (
                latestPrice &&
                latestPrice.price !== '0' &&
                !latestPrice.source?.startsWith('manual')
              ) {
                const price = parseFloat(latestPrice.price);
                if (!Number.isNaN(price) && price > 0) {
                  const lastSuccessfulPrice = {
                    price: latestPrice.price,
                    timestamp: latestPrice.timestamp,
                    source: `${latestPrice.source}_stale_fallback`,
                    baseTokenId: latestPrice.baseTokenId,
                  };

                  const fallbackPrice = await this.convertCachedPriceIfNeeded(
                    lastSuccessfulPrice,
                    baseCurrencyToken.id,
                    timestamp,
                    fallbackBaseCurrencyTokensMap,
                    baseCurrencyToken
                  );

                  results.set(token.id, fallbackPrice);
                  pricingLogger.info(
                    {
                      tokenId: token.id,
                      symbol: token.symbol,
                      fallbackPrice,
                      fallbackSource: lastSuccessfulPrice.source,
                      originalTimestamp: lastSuccessfulPrice.timestamp,
                    },
                    'Using last successful price as fallback in batch operation after all providers failed'
                  );
                  continue;
                }
              }

              results.set(token.id, '0');
            }
          }
        }

        return results;
      } finally {
        this.ongoingRequests.delete(deduplicationKey);
      }
    })();

    this.ongoingRequests.set(deduplicationKey, requestPromise);
    return requestPromise;
  }

  private async getCachedPrice(
    tokenId: string,
    baseCurrencyId: string,
    timestamp: Date
  ): Promise<CachedPrice | null> {
    const isLive = this.isLivePrice(timestamp);
    const maxAge = isLive ? this.LIVE_PRICE_WINDOW_MS : this.HISTORICAL_PRICE_WINDOW_MS;

    // Try to get cached price within the time window
    const price = await this.tokenPriceRepository.findPriceAtTimestamp(
      tokenId,
      baseCurrencyId,
      timestamp,
      maxAge
    );

    if (price) {
      return {
        price: price.price,
        timestamp: price.timestamp,
        source: price.source || 'cached',
        baseTokenId: price.baseTokenId,
      };
    }

    // For manual prices (private tokens), check for any price without time restriction
    // Manual prices don't expire and should be used until explicitly updated
    // Note: We don't filter by base currency here to allow conversion
    const latestPrice = await this.tokenPriceRepository.findLatestPrice(tokenId, baseCurrencyId);

    if (latestPrice?.source?.startsWith('manual')) {
      pricingLogger.debug(
        {
          tokenId,
          requestedBaseCurrency: baseCurrencyId,
          priceBaseCurrency: latestPrice.baseTokenId,
          source: latestPrice.source,
          timestamp: latestPrice.timestamp,
        },
        'Found manual price for private token'
      );
      return {
        price: latestPrice.price,
        timestamp: latestPrice.timestamp,
        source: latestPrice.source,
        baseTokenId: latestPrice.baseTokenId,
      };
    }

    return null;
  }

  /**
   * Get the last successful (non-zero) cached price for a token, ignoring time windows.
   * This is used as a fallback when all pricing providers fail to return a valid price.
   *
   * @param tokenId - The token ID to get the last successful price for
   * @param baseCurrencyId - The base currency ID
   * @returns The last successful cached price, or null if none exists
   */
  private async getLastSuccessfulPrice(
    tokenId: string,
    baseCurrencyId: string
  ): Promise<CachedPrice | null> {
    const latestPrice = await this.tokenPriceRepository.findLatestPrice(tokenId, baseCurrencyId);

    // Only return non-zero prices from external providers (not manual prices, which are handled separately)
    if (latestPrice && latestPrice.price !== '0' && !latestPrice.source?.startsWith('manual')) {
      const price = parseFloat(latestPrice.price);
      if (!Number.isNaN(price) && price > 0) {
        return {
          price: latestPrice.price,
          timestamp: latestPrice.timestamp,
          source: `${latestPrice.source}_stale_fallback`,
          baseTokenId: latestPrice.baseTokenId,
        };
      }
    }

    return null;
  }

  /**
   * Convert a cached price to the target base currency if needed.
   * Used when applying fallback prices from cache.
   *
   * @param cachedPrice - The cached price to convert
   * @param targetBaseCurrencyId - The target base currency ID
   * @param timestamp - The timestamp for the conversion
   * @param baseCurrencyTokensMap - Optional pre-fetched map of base currency tokens to avoid DB calls
   * @param targetBaseCurrencyToken - Optional pre-fetched target base currency token
   * @returns The converted price string
   */
  private async convertCachedPriceIfNeeded(
    cachedPrice: CachedPrice,
    targetBaseCurrencyId: string,
    timestamp: Date,
    baseCurrencyTokensMap?: Map<string, Token>,
    targetBaseCurrencyToken?: Token
  ): Promise<string> {
    if (cachedPrice.baseTokenId === targetBaseCurrencyId) {
      return cachedPrice.price;
    }

    // Try to use pre-fetched token first, fall back to DB if needed
    const cachedBaseCurrencyToken = baseCurrencyTokensMap?.get(cachedPrice.baseTokenId) ||
      await this.tokenRepository.findById(cachedPrice.baseTokenId);

    if (cachedBaseCurrencyToken) {
      // Try to use pre-fetched target token first, fall back to DB if needed
      const targetToken = targetBaseCurrencyToken ||
        await this.tokenRepository.findById(targetBaseCurrencyId);
      if (targetToken) {
        return await this.convertPrice(
          cachedPrice.price,
          cachedBaseCurrencyToken.symbol,
          targetToken.symbol,
          timestamp
        );
      }
    }

    return cachedPrice.price;
  }

  private async getBatchCachedPrices(
    tokenIds: string[],
    baseCurrencyId: string,
    timestamp: Date
  ): Promise<Map<string, CachedPrice>> {
    const results = new Map<string, CachedPrice>();

    if (tokenIds.length === 0) return results;

    // PERFORMANCE FIX: Deduplicate token IDs before querying
    const uniqueTokenIds = Array.from(new Set(tokenIds));

    // Get latest prices for all tokens
    const latestPrices = await this.tokenPriceRepository.findLatestPricesForTokens(
      uniqueTokenIds,
      baseCurrencyId
    );

    const isLive = this.isLivePrice(timestamp);
    const maxAge = isLive ? this.LIVE_PRICE_WINDOW_MS : this.HISTORICAL_PRICE_WINDOW_MS;
    const minTimestamp = new Date(timestamp.getTime() - maxAge);

    for (const [tokenId, price] of latestPrices.entries()) {
      // Check if price is within the time window OR is a manual price
      if (price.timestamp >= minTimestamp || price.source?.startsWith('manual')) {
        if (price.source?.startsWith('manual')) {
          pricingLogger.debug(
            {
              tokenId,
              source: price.source,
              timestamp: price.timestamp,
            },
            'Using manual price in batch without time restriction'
          );
        }
        results.set(tokenId, {
          price: price.price,
          timestamp: price.timestamp,
          source: price.source || 'cached',
          baseTokenId: price.baseTokenId,
        });
      }
    }

    return results;
  }

  private async getCurrencyConversionRate(
    fromCurrency: string,
    toCurrency: string,
    _timestamp: Date
  ): Promise<string> {
    if (fromCurrency === toCurrency) {
      return '1';
    }

    const cacheKey = this.getCurrencyConversionCacheKey(fromCurrency, toCurrency);
    const cached = this.currencyRateCache.get(cacheKey);
    const now = Date.now();

    if (cached) {
      if (cached.expiresAt > now) {
        logger.debug({ fromCurrency, toCurrency }, 'Using cached currency conversion rate');
        return cached.rate;
      }
      this.currencyRateCache.delete(cacheKey);
    }

    try {
      const url = `${PROVIDER_CONFIGS.exchangeRate.baseUrl}/${fromCurrency}`;
      const response = await fetchWithTimeout(url);

      if (!response.ok) {
        throw new Error(
          `ExchangeRate-API responded with ${response.status}: ${response.statusText}`
        );
      }

      const data = (await response.json()) as {
        rates: Record<string, number>;
      };

      if (!data.rates?.[toCurrency]) {
        throw new Error(`No conversion rate available from ${fromCurrency} to ${toCurrency}`);
      }

      const conversionRate = data.rates[toCurrency];
      const rateString = conversionRate.toString();

      logger.debug(
        { fromCurrency, toCurrency, rate: conversionRate, apiUrl: url },
        'Currency conversion rate fetched'
      );

      this.currencyRateCache.set(cacheKey, {
        rate: rateString,
        expiresAt: now + this.CURRENCY_CONVERSION_TTL_MS,
      });

      return rateString;
    } catch (error) {
      logger.warn({ fromCurrency, toCurrency, error }, 'Failed to get currency conversion rate');
      return '0';
    }
  }

  private getCurrencyConversionCacheKey(fromCurrency: string, toCurrency: string): string {
    return `${fromCurrency.toUpperCase()}->${toCurrency.toUpperCase()}`;
  }

  private async convertPrice(
    price: string,
    fromCurrency: string,
    toCurrency: string,
    timestamp: Date
  ): Promise<string> {
    if (fromCurrency === toCurrency || price === '0') {
      return price;
    }

    try {
      const conversionRate = await this.getCurrencyConversionRate(
        fromCurrency,
        toCurrency,
        timestamp
      );

      if (conversionRate === '0') {
        return '0';
      }

      let rate = parseFloat(conversionRate);
      if (rate > 10) {
        rate = 1 / rate;
      }
      const originalPrice = parseFloat(price);
      const convertedPrice = originalPrice * rate;

      logger.debug(
        {
          originalPrice,
          rate,
          convertedPrice,
          fromCurrency,
          toCurrency,
        },
        'Price converted (with inversion check)'
      );

      return convertedPrice.toString();
    } catch (error) {
      logger.error({ error, price, fromCurrency, toCurrency }, 'Price conversion failed');
      return '0';
    }
  }

  private async groupTokensByProvider(
    tokensToGroup: Token[]
  ): Promise<Map<PricingProviderKey, TokenWithProvider[]>> {
    const groupedTokens = new Map<PricingProviderKey, TokenWithProvider[]>();

    if (tokensToGroup.length === 0) return groupedTokens;

    // Get token types for all tokens using repository
    const tokensWithType = await Promise.all(
      tokensToGroup.map(async (token) => {
        const tokenWithType = await this.tokenRepository.findWithType(token.id);
        return {
          token,
          typeCode: tokenWithType?.typeCode || null,
        };
      })
    );

    for (const { token, typeCode } of tokensWithType) {
      if (!typeCode) continue;

      let provider: PricingProviderKey | null = null;
      let providerTokenId: string | undefined;

      try {
        const metadata = JSON.parse(token.providerMetadata || '{}');

        if (metadata.finnhub?.symbol) {
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
        } else if (metadata.coingecko?.id || metadata.coinGeckoId) {
          provider = 'coinGecko';
          providerTokenId = metadata.coingecko?.id || metadata.coinGeckoId;
          logger.info(
            {
              tokenId: token.id,
              symbol: token.symbol,
              typeCode,
              coinGeckoId: providerTokenId,
            },
            'Assigning token to CoinGecko based on provider metadata (overriding type-based assignment)'
          );
        } else if (typeCode.toLowerCase() === 'crypto') {
          // Crypto tokens: Try CoinGecko first (primary provider for crypto)
          // DeFiLlama will be used as fallback if CoinGecko fails
          provider = 'coinGecko';
          providerTokenId = this.getProviderTokenId(provider, token, metadata);
          logger.info(
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
          provider = this.getProviderByTokenType(typeCode, token);
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

    return groupedTokens;
  }

  private getProviderByTokenType(typeCode: string, token: Token): PricingProviderKey | null {
    switch (typeCode.toLowerCase()) {
      case 'fiat':
        return 'exchangeRate';

      case 'crypto':
        return 'coinGecko';

      case 'stock':
        // 'stock' type covers Stock/ETF/Equity/Commodity as per seed data
        return 'finnhub';

      case 'private-company':
      case 'other':
        // Private tokens use manual pricing only, no external provider
        return null;

      default:
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
        // DeFiLlama uses format "chainId:contractAddress"
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
    tokensByProvider: Map<PricingProviderKey, TokenWithProvider[]>,
    baseCurrencyToken: Token,
    timestamp: Date
  ): Promise<ProviderPriceResult[]> {
    const context: ProviderExecutionContext = {
      baseCurrency: baseCurrencyToken,
      timestamp,
    };

    const allResults: ProviderPriceResult[] = [];

    const primaryProviders: PrimaryProviderKey[] = [
      'exchangeRate',
      'coinGecko',
      'finnhub',
      'defiLlama', // Added to fetch ERC-20 token prices
    ];

    const providerPromises = primaryProviders.map(async (providerKey) => {
      const tokensForProvider = tokensByProvider.get(providerKey);
      if (!tokensForProvider || tokensForProvider.length === 0) {
        return [] as ProviderPriceResult[];
      }

      const provider = this.providers[providerKey];
      if (!provider) {
        return [] as ProviderPriceResult[];
      }

      try {
        return await provider.fetchPrices(tokensForProvider, context);
      } catch (error) {
        logger.error({ error, provider: providerKey }, 'Provider fetch failed');
        return tokensForProvider.map(({ token }) =>
          this.createFailureResult(token.id, timestamp, provider.key, error)
        );
      }
    });

    const providerResults = await Promise.all(providerPromises);
    for (const results of providerResults) {
      allResults.push(...results);
    }

    // DeFiLlama fallback for crypto tokens that failed CoinGecko
    // Check for crypto tokens with contract addresses that got empty CoinGecko responses
    const tokensNeedingDeFiLlamaFallback: TokenWithProvider[] = [];

    for (const [providerKey, tokensForProvider] of tokensByProvider.entries()) {
      if (providerKey === 'coinGecko') {
        for (const tokenWithProvider of tokensForProvider) {
          try {
            const metadata = JSON.parse(tokenWithProvider.token.providerMetadata || '{}');

            // Check if token has contract address (can use DeFiLlama)
            if (metadata.contractAddress && metadata.chainId) {
              // Check if CoinGecko failed for this token
              const coinGeckoResult = allResults.find(
                (r) => r.tokenId === tokenWithProvider.token.id && r.source?.includes('CoinGecko')
              );

              if (
                coinGeckoResult &&
                (coinGeckoResult.price === '0' || coinGeckoResult.source?.includes('empty'))
              ) {
                // CoinGecko failed, try DeFiLlama
                tokensNeedingDeFiLlamaFallback.push({
                  token: tokenWithProvider.token,
                  provider: 'defiLlama',
                  providerTokenId: `${metadata.chainId}:${metadata.contractAddress}`,
                });

                logger.info(
                  {
                    tokenId: tokenWithProvider.token.id,
                    symbol: tokenWithProvider.token.symbol,
                    contractAddress: metadata.contractAddress,
                    chainId: metadata.chainId,
                  },
                  'CoinGecko failed, falling back to DeFiLlama for token with contract address'
                );
              }
            }
          } catch (_error) {
            // Ignore parsing errors
          }
        }
      }
    }

    // Fetch prices from DeFiLlama for fallback tokens
    if (tokensNeedingDeFiLlamaFallback.length > 0) {
      const defiLlamaProvider = this.providers.defiLlama;
      if (defiLlamaProvider) {
        try {
          logger.info(
            { tokenCount: tokensNeedingDeFiLlamaFallback.length },
            'Fetching DeFiLlama fallback prices for tokens that failed CoinGecko'
          );

          const defiLlamaResults = await defiLlamaProvider.fetchPrices(
            tokensNeedingDeFiLlamaFallback,
            context
          );

          // Replace failed CoinGecko results with DeFiLlama results
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

      const eligibleTokens = await this.googleSheetsProvider.filterEligibleTokens(
        Array.from(tokenMap.values())
      );

      if (eligibleTokens.length > 0) {
        const googleTokens: TokenWithProvider[] = eligibleTokens.map((token) => ({
          token,
          provider: 'googleSheets',
        }));

        try {
          const googleResults = await this.googleSheetsProvider.fetchPrices(googleTokens, context);

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

  private isEligibleForSheetsByFailure(
    existingResults: ProviderPriceResult[],
    tokenId: string
  ): boolean {
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

  private async cachePriceResults(
    results: ProviderPriceResult[],
    baseCurrencyId: string
  ): Promise<void> {
    if (results.length === 0) return;

    logger.debug(
      {
        resultCount: results.length,
        sources: results.map((r) => r.source),
        baseCurrencyId,
      },
      'Caching price results to database'
    );

    // CRITICAL FIX: Filter out zero prices from caching
    // Zero prices indicate failures and should never be persisted to the database
    // This prevents pollution of price cache with failure states
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

  private isLivePrice(timestamp: Date): boolean {
    const now = new Date();
    const diffMs = now.getTime() - timestamp.getTime();
    return diffMs < 2 * 60 * 60 * 1000;
  }

  private shouldCacheFailure(
    error: unknown,
    response?: Response,
    dataEmpty?: boolean
  ): {
    shouldCache: boolean;
    cacheWindow: number;
    sourcePrefix: string;
    isTierLimitation?: boolean;
  } {
    if (error && typeof error === 'object' && 'code' in error) {
      const nodeError = error as { code: string };
      if (nodeError.code === 'ECONNRESET' || nodeError.code === 'ENOTFOUND') {
        return {
          shouldCache: false,
          cacheWindow: 0,
          sourcePrefix: 'network_error',
        };
      }
    }

    if (
      response &&
      (response.status === 429 || (response.status >= 500 && response.status < 600))
    ) {
      return {
        shouldCache: false,
        cacheWindow: 0,
        sourcePrefix: 'retryable_error',
      };
    }

    if (response && response.status === 403) {
      return {
        shouldCache: true,
        cacheWindow: this.UNAVAILABLE_CACHE_MS,
        sourcePrefix: 'tier_limitation',
        isTierLimitation: true,
      };
    }

    if (response && response.status === 401) {
      return {
        shouldCache: true,
        cacheWindow: this.UNAVAILABLE_CACHE_MS,
        sourcePrefix: 'unauthorized_access',
        isTierLimitation: true,
      };
    }

    if (dataEmpty === true && response?.ok) {
      return {
        shouldCache: true,
        cacheWindow: this.RETRYABLE_FAILURE_CACHE_MS,
        sourcePrefix: 'empty_response',
      };
    }

    if (response && response.status >= 400 && response.status < 500) {
      const isTierIssue = response.status === 404 && this.isPotentialTierLimitation(error);
      return {
        shouldCache: true,
        cacheWindow: this.UNAVAILABLE_CACHE_MS,
        sourcePrefix: isTierIssue ? 'tier_limitation' : 'unavailable',
        isTierLimitation: isTierIssue,
      };
    }

    return {
      shouldCache: true,
      cacheWindow: this.RETRYABLE_FAILURE_CACHE_MS,
      sourcePrefix: 'unknown_error',
    };
  }

  private isPotentialTierLimitation(error: unknown): boolean {
    if (!(error instanceof Error)) return false;

    const message = error.message.toLowerCase();
    const tierKeywords = [
      'subscription',
      'plan',
      'tier',
      'premium',
      'upgrade',
      'access denied',
      'not authorized',
      'forbidden',
      'limit exceeded',
    ];

    return tierKeywords.some((keyword) => message.includes(keyword));
  }

  private tokenHasFinnhubMetadata(token: Token): boolean {
    try {
      const metadata = JSON.parse(token.providerMetadata || '{}');
      return !!metadata.finnhub?.symbol;
    } catch {
      return false;
    }
  }

  private createFailureResult(
    tokenId: string,
    timestamp: Date,
    providerName: string,
    error: unknown,
    options?: {
      response?: Response;
      dataEmpty?: boolean;
    }
  ): ProviderPriceResult {
    const cacheStrategy = this.shouldCacheFailure(error, options?.response, options?.dataEmpty);

    if (!cacheStrategy.shouldCache) {
      logger.debug(
        { error, tokenId, provider: providerName },
        `${providerName}: Not caching ${cacheStrategy.sourcePrefix}, will retry`
      );
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`${providerName} ${cacheStrategy.sourcePrefix}: ${errorMessage}`);
    }

    if (cacheStrategy.isTierLimitation) {
      this.updateTokenProviderMetadata(tokenId, providerName, cacheStrategy.sourcePrefix, error);
    }

    logger.warn(
      {
        error,
        tokenId,
        provider: providerName,
        cacheWindow: cacheStrategy.cacheWindow,
        isTierLimitation: cacheStrategy.isTierLimitation,
        sourcePrefix: cacheStrategy.sourcePrefix,
      },
      `${providerName}: Caching ${cacheStrategy.sourcePrefix} for ${cacheStrategy.cacheWindow}ms - Google Sheets fallback may be available`
    );

    return {
      tokenId,
      price: '0',
      timestamp,
      source: `${providerName}_${cacheStrategy.sourcePrefix}`,
    };
  }

  private async updateTokenProviderMetadata(
    tokenId: string,
    providerName: string,
    sourcePrefix: string,
    error: unknown
  ): Promise<void> {
    try {
      const token = await this.tokenRepository.findById(tokenId);
      if (!token) {
        logger.warn(`Token ${tokenId} not found for metadata update`);
        return;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);

      let currentMetadata = {} as Record<string, unknown>;
      if (token.providerMetadata) {
        try {
          currentMetadata =
            typeof token.providerMetadata === 'string'
              ? JSON.parse(token.providerMetadata)
              : (token.providerMetadata as Record<string, unknown>);
        } catch (parseError) {
          logger.warn(`Failed to parse existing metadata for token ${tokenId}: ${parseError}`);
          currentMetadata = {};
        }
      }

      const updatedMetadata = {
        ...currentMetadata,
        pricingUnavailable: {
          provider: providerName,
          reason: sourcePrefix,
          message: errorMessage,
          detectedAt: new Date().toISOString(),
          requiresPremium: sourcePrefix.includes('tier') || sourcePrefix.includes('unauthorized'),
        },
      };

      await this.tokenRepository.update(tokenId, {
        providerMetadata: JSON.stringify(updatedMetadata),
        updatedAt: new Date(),
      });

      logger.info(
        {
          tokenId,
          symbol: token.symbol,
          provider: providerName,
          sourcePrefix,
          requiresPremium: updatedMetadata.pricingUnavailable.requiresPremium,
        },
        'Updated token metadata for pricing limitation'
      );
    } catch (err) {
      logger.error(
        {
          tokenId,
          error: err instanceof Error ? err.message : String(err),
        },
        'Failed to update token metadata'
      );
    }
  }

  /**
   * Get cached token prices only - does not fetch from external providers
   * Returns prices from database or '0' if not found
   */
  async getCachedTokenPrices(
    tokensToPrice: Token[],
    baseCurrencySymbol: string,
    timestamp: Date
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();

    if (tokensToPrice.length === 0) return results;

    const baseCurrencyToken = await this.tokenRepository.findBySymbol(baseCurrencySymbol);
    if (!baseCurrencyToken) {
      logger.warn({ baseCurrencySymbol }, 'Base currency token not found in getCachedTokenPrices');
      for (const token of tokensToPrice) {
        results.set(token.id, '0');
      }
      return results;
    }

    const tokensToProcess = tokensToPrice.filter((token) => {
      if (token.id === baseCurrencyToken.id) {
        results.set(token.id, '1');
        return false;
      }
      return true;
    });

    if (tokensToProcess.length === 0) return results;

    const cachedPrices = await this.getBatchCachedPrices(
      tokensToProcess.map((t) => t.id),
      baseCurrencyToken.id,
      timestamp
    );

    // PERFORMANCE FIX: Batch fetch all unique base currency tokens needed for conversion
    const uniqueBaseCurrencyIds = new Set<string>();
    for (const cached of cachedPrices.values()) {
      if (cached.baseTokenId !== baseCurrencyToken.id) {
        uniqueBaseCurrencyIds.add(cached.baseTokenId);
      }
    }

    const baseCurrencyTokensMap = new Map<string, typeof baseCurrencyToken>();
    if (uniqueBaseCurrencyIds.size > 0) {
      const baseCurrencyTokens = await this.tokenRepository.findByIds(
        Array.from(uniqueBaseCurrencyIds)
      );
      for (const token of baseCurrencyTokens) {
        baseCurrencyTokensMap.set(token.id, token);
      }
    }

    // PERFORMANCE FIX: Batch fetch last successful prices for tokens without cached prices
    const tokensNeedingFallback = tokensToProcess.filter((t) => !cachedPrices.has(t.id));
    const fallbackPrices = new Map<string, CachedPrice>();

    if (tokensNeedingFallback.length > 0) {
      // PERFORMANCE FIX: Deduplicate token IDs before querying
      const uniqueTokenIds = Array.from(new Set(tokensNeedingFallback.map((t) => t.id)));
      
      const latestPrices = await this.tokenPriceRepository.findLatestPricesForTokens(
        uniqueTokenIds,
        baseCurrencyToken.id
      );

      for (const [tokenId, price] of latestPrices.entries()) {
        // Only use non-zero prices from external providers as fallback
        if (price.price !== '0' && !price.source?.startsWith('manual')) {
          const priceValue = parseFloat(price.price);
          if (!Number.isNaN(priceValue) && priceValue > 0) {
            fallbackPrices.set(tokenId, {
              price: price.price,
              timestamp: price.timestamp,
              source: `${price.source}_stale_fallback`,
              baseTokenId: price.baseTokenId,
            });
          }
        }
      }
    }

    // PERFORMANCE FIX: Batch fetch all unique base currency tokens for fallback conversions
    const uniqueFallbackBaseCurrencyIds = new Set<string>();
    for (const fallbackPrice of fallbackPrices.values()) {
      if (fallbackPrice.baseTokenId !== baseCurrencyToken.id) {
        uniqueFallbackBaseCurrencyIds.add(fallbackPrice.baseTokenId);
      }
    }

    const fallbackBaseCurrencyTokensMap = new Map<string, typeof baseCurrencyToken>();
    if (uniqueFallbackBaseCurrencyIds.size > 0) {
      const fallbackBaseCurrencyTokens = await this.tokenRepository.findByIds(
        Array.from(uniqueFallbackBaseCurrencyIds)
      );
      for (const token of fallbackBaseCurrencyTokens) {
        fallbackBaseCurrencyTokensMap.set(token.id, token);
      }
    }

    // Process all tokens with batched data
    for (const token of tokensToProcess) {
      const cached = cachedPrices.get(token.id);
      if (cached) {
        // Check if currency conversion is needed
        if (cached.baseTokenId !== baseCurrencyToken.id) {
          const cachedBaseCurrencyToken = baseCurrencyTokensMap.get(cached.baseTokenId);

          if (cachedBaseCurrencyToken) {
            pricingLogger.debug(
              {
                tokenId: token.id,
                symbol: token.symbol,
                fromCurrency: cachedBaseCurrencyToken.symbol,
                toCurrency: baseCurrencyToken.symbol,
                originalPrice: cached.price,
              },
              'Converting cached price to requested base currency in cached-only batch'
            );

            const convertedPrice = await this.convertPrice(
              cached.price,
              cachedBaseCurrencyToken.symbol,
              baseCurrencyToken.symbol,
              timestamp
            );

            results.set(token.id, convertedPrice);
            continue;
          }
        }

        results.set(token.id, cached.price);
      } else {
        // Use batched fallback price
        const lastSuccessfulPrice = fallbackPrices.get(token.id);

        if (lastSuccessfulPrice) {
          const fallbackPrice = await this.convertCachedPriceIfNeeded(
            lastSuccessfulPrice,
            baseCurrencyToken.id,
            timestamp,
            fallbackBaseCurrencyTokensMap,
            baseCurrencyToken
          );

          pricingLogger.info(
            {
              tokenId: token.id,
              symbol: token.symbol,
              fallbackPrice,
              fallbackSource: lastSuccessfulPrice.source,
              originalTimestamp: lastSuccessfulPrice.timestamp,
            },
            'Using last successful price as fallback in cached-only pricing'
          );

          results.set(token.id, fallbackPrice);
        } else {
          // No cached or fallback price found - return '0'
          results.set(token.id, '0');
        }
      }
    }

    return results;
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
    // Skip validation for non-crypto tokens (they use other providers)
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

      const context: ProviderExecutionContext = {
        baseCurrency: baseCurrencyToken,
        timestamp: new Date(),
      };

      // Try CoinGecko first
      const coinGeckoId =
        (tokenData.metadata.coingecko as { id?: string })?.id || tokenData.symbol.toLowerCase();
      const coinGeckoProvider = this.providers.coinGecko;

      if (coinGeckoProvider) {
        try {
          const coinGeckoResults = await coinGeckoProvider.fetchPrices(
            [
              {
                token: {
                  id: 'temp-validation-id',
                  symbol: tokenData.symbol,
                  name: tokenData.name,
                  typeId: 'temp',
                  decimals: 18,
                  iconUrl: null,
                  providerMetadata: JSON.stringify(tokenData.metadata),
                  isActive: true,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                },
                provider: 'coinGecko',
                providerTokenId: coinGeckoId,
              },
            ],
            context
          );

          const coinGeckoResult = coinGeckoResults[0];
          if (
            coinGeckoResult &&
            coinGeckoResult.price !== '0' &&
            !coinGeckoResult.source?.includes('empty')
          ) {
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

      // Try DeFiLlama fallback if token has contract address
      const contractAddress = tokenData.metadata.contractAddress as string | undefined;
      const chainId = tokenData.metadata.chainId as number | undefined;

      if (contractAddress && chainId) {
        const defiLlamaProvider = this.providers.defiLlama;
        if (defiLlamaProvider) {
          try {
            const defiLlamaResults = await defiLlamaProvider.fetchPrices(
              [
                {
                  token: {
                    id: 'temp-validation-id',
                    symbol: tokenData.symbol,
                    name: tokenData.name,
                    typeId: 'temp',
                    decimals: 18,
                    iconUrl: null,
                    providerMetadata: JSON.stringify(tokenData.metadata),
                    isActive: true,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                  },
                  provider: 'defiLlama',
                  providerTokenId: `${chainId}:${contractAddress}`,
                },
              ],
              context
            );

            const defiLlamaResult = defiLlamaResults[0];
            if (
              defiLlamaResult &&
              defiLlamaResult.price !== '0' &&
              !defiLlamaResult.source?.includes('empty')
            ) {
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
}
