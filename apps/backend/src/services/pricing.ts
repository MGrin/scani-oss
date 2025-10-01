import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { config } from "../config/pricing";
import { db } from "../db/connection";
import type { NewTokenPrice, Token } from "../db/schema";
import { tokenPrices, tokens, tokenTypes } from "../db/schema";
import { createComponentLogger, logger } from "../utils/logger";
import { PROVIDER_CONFIGS } from "./pricing/provider-config";
import type {
  ConvertPriceFn,
  PricingProvider,
  ProviderExecutionContext,
} from "./pricing/providers/base";
import { CoinGeckoProvider } from "./pricing/providers/coingecko";
import { ExchangeRateProvider } from "./pricing/providers/exchange-rate";
import { FinnhubProvider } from "./pricing/providers/finnhub";
import { GoogleSheetsProvider } from "./pricing/providers/google-sheets";
import type {
  PricingProviderKey,
  ProviderPriceResult,
  TokenWithProvider,
} from "./pricing/types";
import { fetchWithTimeout, RateLimiter } from "./pricing/utils";

const pricingLogger = createComponentLogger("pricing");

type PrimaryProviderKey = Exclude<PricingProviderKey, "googleSheets">;

type ProviderRegistry = Record<PrimaryProviderKey, PricingProvider>;

interface CachedPrice {
  price: string;
  timestamp: Date;
  source: string;
  baseTokenId: string;
}

interface TokenLookupResult {
  symbol: string;
  name: string;
  provider: string;
  providerTokenId: string;
  tokenType: string;
}

export class PricingService {
  private readonly LIVE_PRICE_WINDOW_MS = 60 * 60 * 1000;
  private readonly HISTORICAL_PRICE_WINDOW_MS = 24 * 60 * 60 * 1000;
  private readonly UNAVAILABLE_CACHE_MS = 60 * 60 * 1000;
  private readonly RETRYABLE_FAILURE_CACHE_MS = 5 * 60 * 1000;

  public readonly finnhubRateLimiter = new RateLimiter(50, 60 * 1000);
  // CoinGecko Demo/Public API: ~30 calls/min, use 10 for safety under ANY load
  // Reference: https://docs.coingecko.com/docs/common-errors-rate-limit
  public readonly coinGeckoRateLimiter = new RateLimiter(10, 60 * 1000);
  private readonly googleSheetsRateLimiter = new RateLimiter(100, 100 * 1000);

  private readonly providers: ProviderRegistry;
  private readonly googleSheetsProvider: GoogleSheetsProvider;
  private readonly googleSheetsAvailable: boolean;

  private readonly ongoingRequests = new Map<
    string,
    Promise<Map<string, string>>
  >();
  private readonly currencyRateCache = new Map<
    string,
    { rate: string; expiresAt: number }
  >();
  private readonly CURRENCY_CONVERSION_TTL_MS = 10 * 60 * 1000;

  constructor(private readonly database = db) {
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
      finnhub: new FinnhubProvider({
        rateLimiter: this.finnhubRateLimiter,
        convertPrice: convertPriceBound,
        createFailureResult: createFailureResultBound,
        logger: createComponentLogger("pricing:finnhub"),
      }),
    } satisfies ProviderRegistry;

    this.googleSheetsProvider = new GoogleSheetsProvider({
      db: this.database,
      rateLimiter: this.googleSheetsRateLimiter,
      finnhubRateLimiter: this.finnhubRateLimiter,
      convertPrice: convertPriceBound,
      createFailureResult: createFailureResultBound,
      logger: createComponentLogger("pricing:googleSheets"),
    });

    this.googleSheetsAvailable = this.googleSheetsProvider.isAvailable();
  }

  async getTokenPrice(
    token: Token,
    baseCurrencySymbol: string,
    timestamp: Date
  ): Promise<string> {
    const baseCurrencyToken = await this.getTokenBySymbol(baseCurrencySymbol);
    if (!baseCurrencyToken) {
      pricingLogger.debug(
        { baseCurrencySymbol },
        "Base currency token not found in getTokenPrice"
      );
      return "0";
    }

    if (token.id === baseCurrencyToken.id) {
      return "1";
    }

    const cached = await this.getCachedPrice(
      token.id,
      baseCurrencyToken.id,
      timestamp
    );

    if (cached && cached.price !== "0") {
      // Check if currency conversion is needed
      if (cached.baseTokenId !== baseCurrencyToken.id) {
        // Get the token for the cached price's base currency
        const cachedBaseCurrencyToken = await this.database
          .select()
          .from(tokens)
          .where(eq(tokens.id, cached.baseTokenId))
          .limit(1)
          .then((rows) => rows[0]);

        if (cachedBaseCurrencyToken) {
          pricingLogger.debug(
            {
              tokenId: token.id,
              symbol: token.symbol,
              fromCurrency: cachedBaseCurrencyToken.symbol,
              toCurrency: baseCurrencyToken.symbol,
              originalPrice: cached.price,
            },
            "Converting cached price to requested base currency"
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
      cached && cached.price === "0" && cached.source?.includes("Finnhub");
    const hasFinnhubMetadata = this.tokenHasFinnhubMetadata(token);

    if (
      hasFailedFinnhubCache &&
      hasFinnhubMetadata &&
      this.googleSheetsAvailable
    ) {
      pricingLogger.debug(
        {
          tokenId: token.id,
          symbol: token.symbol,
          cachedSource: cached.source,
        },
        "Token has failed Finnhub cache but Finnhub metadata - forcing fresh fetch with Google Sheets fallback"
      );
    }

    const tokensByProvider = await this.groupTokensByProvider([token]);
    const freshPrices = await this.fetchFromAllProviders(
      tokensByProvider,
      baseCurrencyToken,
      timestamp
    );

    const priceResult = freshPrices.find((p) => p.tokenId === token.id);
    const finalPrice = priceResult?.price || "0";

    if (hasFinnhubMetadata && finalPrice === "0") {
      logger.warn(
        { tokenId: token.id, symbol: token.symbol },
        "Token with Finnhub metadata still has no price after fresh fetch - check Google Sheets configuration"
      );
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
      .join(",");
    const timestampMinute =
      Math.floor(timestamp.getTime() / (60 * 1000)) * 60 * 1000;
    const deduplicationKey = `getTokenPrices:${tokenIds}:${baseCurrencySymbol}:${timestampMinute}`;

    const ongoingRequest = this.ongoingRequests.get(deduplicationKey);
    if (ongoingRequest) {
      logger.debug(
        { deduplicationKey },
        "Deduplicating concurrent getTokenPrices request"
      );
      return await ongoingRequest;
    }

    const requestPromise = (async (): Promise<Map<string, string>> => {
      try {
        const baseCurrencyToken = await this.getTokenBySymbol(
          baseCurrencySymbol
        );
        if (!baseCurrencyToken) {
          logger.warn(
            { baseCurrencySymbol },
            "Base currency token not found in getTokenPrices"
          );
          for (const token of tokensToPrice) {
            results.set(token.id, "0");
          }
          return results;
        }

        const tokensToProcess = tokensToPrice.filter((token) => {
          if (token.id === baseCurrencyToken.id) {
            results.set(token.id, "1");
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

        const tokensNeedingPrices: Token[] = [];

        for (const token of tokensToProcess) {
          const cached = cachedPrices.get(token.id);
          if (cached) {
            // Check if currency conversion is needed
            if (cached.baseTokenId !== baseCurrencyToken.id) {
              // Get the token for the cached price's base currency
              const cachedBaseCurrencyToken = await this.database
                .select()
                .from(tokens)
                .where(eq(tokens.id, cached.baseTokenId))
                .limit(1)
                .then((rows) => rows[0]);

              if (cachedBaseCurrencyToken) {
                pricingLogger.debug(
                  {
                    tokenId: token.id,
                    symbol: token.symbol,
                    fromCurrency: cachedBaseCurrencyToken.symbol,
                    toCurrency: baseCurrencyToken.symbol,
                    originalPrice: cached.price,
                  },
                  "Converting cached price to requested base currency in batch"
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
            "Fetching prices from external providers"
          );

          const tokensByProvider = await this.groupTokensByProvider(
            tokensNeedingPrices
          );
          const freshPrices = await this.fetchFromAllProviders(
            tokensByProvider,
            baseCurrencyToken,
            timestamp
          );

          for (const priceResult of freshPrices) {
            results.set(priceResult.tokenId, priceResult.price);
          }

          for (const token of tokensNeedingPrices) {
            if (!results.has(token.id)) {
              results.set(token.id, "0");
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

  async lookupToken(symbol: string): Promise<TokenLookupResult | null> {
    logger.info({ symbol }, "Looking up token from external providers");

    try {
      const [finnhubResult, coinGeckoResult] = await Promise.all([
        this.lookupTokenFromFinnhub(symbol),
        this.lookupTokenFromCoinGecko(symbol),
      ]);

      if (coinGeckoResult) {
        logger.info(
          { symbol, provider: "coingecko" },
          "Token found via CoinGecko"
        );
        return coinGeckoResult;
      }

      if (finnhubResult) {
        logger.info({ symbol, provider: "finnhub" }, "Token found via Finnhub");
        return finnhubResult;
      }

      logger.info({ symbol }, "Token not found in any provider");
      return null;
    } catch (error) {
      logger.error({ error, symbol }, "Error looking up token from providers");
      return null;
    }
  }

  private async lookupTokenFromFinnhub(
    symbol: string
  ): Promise<TokenLookupResult | null> {
    try {
      const apiKey = config.finnhub.apiKey;
      if (!apiKey) return null;

      const profileResponse = await this.finnhubRateLimiter.execute(
        async () => {
          const url = `${config.finnhub.baseUrl}/stock/profile2?symbol=${symbol}&token=${apiKey}`;
          return await fetchWithTimeout(url);
        }
      );

      if (!profileResponse.ok) return null;

      const profileData = (await profileResponse.json()) as {
        name?: string;
        exchange?: string;
      };

      if (!profileData.name || !profileData.exchange) return null;

      return {
        symbol: symbol.toUpperCase(),
        name: profileData.name,
        provider: "finnhub",
        providerTokenId: symbol.toUpperCase(),
        tokenType: "stock",
      };
    } catch (error) {
      logger.debug({ error, symbol }, "Finnhub lookup failed");
      return null;
    }
  }

  private async lookupTokenFromCoinGecko(
    symbol: string
  ): Promise<TokenLookupResult | null> {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (config.coinGecko.apiKey) {
        headers["x-cg-pro-api-key"] = config.coinGecko.apiKey;
      }

      const searchResponse = await this.coinGeckoRateLimiter.execute(
        async () => {
          const url = `${
            config.coinGecko.baseUrl
          }/search?query=${encodeURIComponent(symbol)}`;
          return await fetchWithTimeout(url, { headers });
        }
      );

      if (!searchResponse.ok) return null;

      const searchData = (await searchResponse.json()) as {
        coins: Array<{
          id: string;
          symbol: string;
          name: string;
        }>;
      };

      if (!searchData.coins || searchData.coins.length === 0) return null;

      const exactMatch = searchData.coins.find(
        (coin) => coin.symbol.toLowerCase() === symbol.toLowerCase()
      );
      const coin = exactMatch || searchData.coins[0];
      if (!coin) return null;

      return {
        symbol: coin.symbol.toUpperCase(),
        name: coin.name,
        provider: "coingecko",
        providerTokenId: coin.id,
        tokenType: "crypto",
      };
    } catch (error) {
      logger.debug({ error, symbol }, "CoinGecko lookup failed");
      return null;
    }
  }

  private async getCachedPrice(
    tokenId: string,
    baseCurrencyId: string,
    timestamp: Date
  ): Promise<CachedPrice | null> {
    const isLive = this.isLivePrice(timestamp);
    const maxAge = isLive
      ? this.LIVE_PRICE_WINDOW_MS
      : this.HISTORICAL_PRICE_WINDOW_MS;
    const minTimestamp = new Date(timestamp.getTime() - maxAge);

    const result = await this.database
      .select({
        price: tokenPrices.price,
        timestamp: tokenPrices.timestamp,
        source: tokenPrices.source,
        baseTokenId: tokenPrices.baseTokenId,
      })
      .from(tokenPrices)
      .where(
        and(
          eq(tokenPrices.tokenId, tokenId),
          eq(tokenPrices.baseTokenId, baseCurrencyId),
          gte(tokenPrices.timestamp, minTimestamp)
        )
      )
      .orderBy(desc(tokenPrices.timestamp))
      .limit(1);

    if (result[0]) {
      return {
        price: result[0].price,
        timestamp: result[0].timestamp,
        source: result[0].source || "cached",
        baseTokenId: result[0].baseTokenId,
      };
    }

    // For manual prices (private tokens), check for any price without time restriction
    // Manual prices don't expire and should be used until explicitly updated
    // Note: We don't filter by base currency here to allow conversion
    const manualPriceResult = await this.database
      .select({
        price: tokenPrices.price,
        timestamp: tokenPrices.timestamp,
        source: tokenPrices.source,
        baseTokenId: tokenPrices.baseTokenId,
      })
      .from(tokenPrices)
      .where(eq(tokenPrices.tokenId, tokenId))
      .orderBy(desc(tokenPrices.timestamp))
      .limit(1);

    if (manualPriceResult[0]?.source?.startsWith("manual")) {
      pricingLogger.debug(
        {
          tokenId,
          requestedBaseCurrency: baseCurrencyId,
          priceBaseCurrency: manualPriceResult[0].baseTokenId,
          source: manualPriceResult[0].source,
          timestamp: manualPriceResult[0].timestamp,
        },
        "Found manual price for private token"
      );
      return {
        price: manualPriceResult[0].price,
        timestamp: manualPriceResult[0].timestamp,
        source: manualPriceResult[0].source,
        baseTokenId: manualPriceResult[0].baseTokenId,
      };
    }

    return null;
  }

  private async getBatchCachedPrices(
    tokenIds: string[],
    baseCurrencyId: string,
    timestamp: Date
  ): Promise<Map<string, CachedPrice>> {
    const results = new Map<string, CachedPrice>();

    if (tokenIds.length === 0) return results;

    const isLive = this.isLivePrice(timestamp);
    const maxAge = isLive
      ? this.LIVE_PRICE_WINDOW_MS
      : this.HISTORICAL_PRICE_WINDOW_MS;
    const minTimestamp = new Date(timestamp.getTime() - maxAge);

    const cachedPrices = await this.database
      .selectDistinctOn([tokenPrices.tokenId], {
        tokenId: tokenPrices.tokenId,
        price: tokenPrices.price,
        timestamp: tokenPrices.timestamp,
        source: tokenPrices.source,
        baseTokenId: tokenPrices.baseTokenId,
      })
      .from(tokenPrices)
      .where(
        and(
          inArray(tokenPrices.tokenId, tokenIds),
          eq(tokenPrices.baseTokenId, baseCurrencyId),
          gte(tokenPrices.timestamp, minTimestamp)
        )
      )
      .orderBy(tokenPrices.tokenId, desc(tokenPrices.timestamp));

    for (const price of cachedPrices) {
      results.set(price.tokenId, {
        price: price.price,
        timestamp: price.timestamp,
        source: price.source || "cached",
        baseTokenId: price.baseTokenId,
      });
    }

    // For tokens without cached prices, check for manual prices (no time restriction)
    const tokensWithoutCache = tokenIds.filter((id) => !results.has(id));
    if (tokensWithoutCache.length > 0) {
      const manualPrices = await this.database
        .selectDistinctOn([tokenPrices.tokenId], {
          tokenId: tokenPrices.tokenId,
          price: tokenPrices.price,
          timestamp: tokenPrices.timestamp,
          source: tokenPrices.source,
          baseTokenId: tokenPrices.baseTokenId,
        })
        .from(tokenPrices)
        .where(inArray(tokenPrices.tokenId, tokensWithoutCache))
        .orderBy(tokenPrices.tokenId, desc(tokenPrices.timestamp));

      for (const price of manualPrices) {
        if (price.source?.startsWith("manual")) {
          pricingLogger.debug(
            {
              tokenId: price.tokenId,
              source: price.source,
              timestamp: price.timestamp,
            },
            "Using manual price in batch without time restriction"
          );
          results.set(price.tokenId, {
            price: price.price,
            timestamp: price.timestamp,
            source: price.source,
            baseTokenId: price.baseTokenId,
          });
        }
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
      return "1";
    }

    const cacheKey = this.getCurrencyConversionCacheKey(
      fromCurrency,
      toCurrency
    );
    const cached = this.currencyRateCache.get(cacheKey);
    const now = Date.now();

    if (cached) {
      if (cached.expiresAt > now) {
        logger.debug(
          { fromCurrency, toCurrency },
          "Using cached currency conversion rate"
        );
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
        throw new Error(
          `No conversion rate available from ${fromCurrency} to ${toCurrency}`
        );
      }

      const conversionRate = data.rates[toCurrency];
      const rateString = conversionRate.toString();

      logger.debug(
        { fromCurrency, toCurrency, rate: conversionRate, apiUrl: url },
        "Currency conversion rate fetched"
      );

      this.currencyRateCache.set(cacheKey, {
        rate: rateString,
        expiresAt: now + this.CURRENCY_CONVERSION_TTL_MS,
      });

      return rateString;
    } catch (error) {
      logger.warn(
        { fromCurrency, toCurrency, error },
        "Failed to get currency conversion rate"
      );
      return "0";
    }
  }

  private getCurrencyConversionCacheKey(
    fromCurrency: string,
    toCurrency: string
  ): string {
    return `${fromCurrency.toUpperCase()}->${toCurrency.toUpperCase()}`;
  }

  private async convertPrice(
    price: string,
    fromCurrency: string,
    toCurrency: string,
    timestamp: Date
  ): Promise<string> {
    if (fromCurrency === toCurrency || price === "0") {
      return price;
    }

    try {
      const conversionRate = await this.getCurrencyConversionRate(
        fromCurrency,
        toCurrency,
        timestamp
      );

      if (conversionRate === "0") {
        return "0";
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
        "Price converted (with inversion check)"
      );

      return convertedPrice.toString();
    } catch (error) {
      logger.error(
        { error, price, fromCurrency, toCurrency },
        "Price conversion failed"
      );
      return "0";
    }
  }

  private async groupTokensByProvider(
    tokensToGroup: Token[]
  ): Promise<Map<PricingProviderKey, TokenWithProvider[]>> {
    const groupedTokens = new Map<PricingProviderKey, TokenWithProvider[]>();

    if (tokensToGroup.length === 0) return groupedTokens;

    const tokenTypesMap = await this.database
      .select({
        tokenId: tokens.id,
        typeCode: tokenTypes.code,
      })
      .from(tokens)
      .innerJoin(tokenTypes, eq(tokens.typeId, tokenTypes.id))
      .where(
        inArray(
          tokens.id,
          tokensToGroup.map((t) => t.id)
        )
      );

    const typeCodeLookup = new Map<string, string>();
    for (const row of tokenTypesMap) {
      typeCodeLookup.set(row.tokenId, row.typeCode);
    }

    for (const token of tokensToGroup) {
      const typeCode = typeCodeLookup.get(token.id);
      if (!typeCode) continue;

      let provider: PricingProviderKey | null = null;
      let providerTokenId: string | undefined;

      try {
        const metadata = JSON.parse(token.providerMetadata || "{}");

        if (metadata.finnhub?.symbol) {
          provider = "finnhub";
          providerTokenId = metadata.finnhub.symbol;
          logger.info(
            {
              tokenId: token.id,
              symbol: token.symbol,
              typeCode,
              finnhubSymbol: metadata.finnhub.symbol,
            },
            "Assigning token to Finnhub based on provider metadata (overriding type-based assignment)"
          );
        } else if (metadata.coingecko?.id || metadata.coinGeckoId) {
          provider = "coinGecko";
          providerTokenId = metadata.coingecko?.id || metadata.coinGeckoId;
          logger.info(
            {
              tokenId: token.id,
              symbol: token.symbol,
              typeCode,
              coinGeckoId: providerTokenId,
            },
            "Assigning token to CoinGecko based on provider metadata (overriding type-based assignment)"
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
          "Failed to parse provider metadata, using type-based provider assignment"
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

  private getProviderByTokenType(
    typeCode: string,
    token: Token
  ): PricingProviderKey | null {
    switch (typeCode.toLowerCase()) {
      case "fiat":
        return "exchangeRate";

      case "crypto":
        return "coinGecko";

      case "stock":
        // 'stock' type covers Stock/ETF/Equity/Commodity as per seed data
        return "finnhub";

      case "private-company":
      case "other":
        // Private tokens use manual pricing only, no external provider
        return null;

      default:
        logger.warn(
          {
            tokenId: token.id,
            symbol: token.symbol,
            typeCode,
          },
          "Unknown token type, skipping provider assignment"
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
      case "exchangeRate":
        return token.symbol;
      case "coinGecko": {
        const coinGeckoData = metadata.coingecko as { id?: string } | undefined;
        const coinGeckoId = metadata.coinGeckoId as string | undefined;
        return coinGeckoData?.id || coinGeckoId || token.symbol.toLowerCase();
      }
      case "finnhub": {
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
      "exchangeRate",
      "coinGecko",
      "finnhub",
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
        logger.error({ error, provider: providerKey }, "Provider fetch failed");
        return tokensForProvider.map(({ token }) =>
          this.createFailureResult(token.id, timestamp, provider.key, error)
        );
      }
    });

    const providerResults = await Promise.all(providerPromises);
    for (const results of providerResults) {
      allResults.push(...results);
    }

    const allTokens = Array.from(tokensByProvider.values()).flat();
    const tokensStillNeedingPrices = allTokens.filter((tokenWithProvider) => {
      const hasSuccessfulPrice = allResults.some(
        (result) =>
          result.tokenId === tokenWithProvider.token.id && result.price !== "0"
      );
      if (hasSuccessfulPrice) {
        return false;
      }
      return this.isEligibleForSheetsByFailure(
        allResults,
        tokenWithProvider.token.id
      );
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
      "Checking tokens for Google Sheets fallback"
    );

    if (tokensStillNeedingPrices.length > 0 && this.googleSheetsAvailable) {
      const tokenMap = new Map<string, Token>();
      for (const { token } of tokensStillNeedingPrices) {
        tokenMap.set(token.id, token);
      }

      const eligibleTokens =
        await this.googleSheetsProvider.filterEligibleTokens(
          Array.from(tokenMap.values())
        );

      if (eligibleTokens.length > 0) {
        const googleTokens: TokenWithProvider[] = eligibleTokens.map(
          (token) => ({
            token,
            provider: "googleSheets",
          })
        );

        try {
          const googleResults = await this.googleSheetsProvider.fetchPrices(
            googleTokens,
            context
          );

          for (const result of googleResults) {
            const existingIndex = allResults.findIndex(
              (r) => r.tokenId === result.tokenId
            );
            if (existingIndex !== -1) {
              allResults.splice(existingIndex, 1);
            }
            allResults.push(result);
          }
        } catch (error) {
          logger.warn({ error }, "Google Sheets fallback failed");
        }
      } else {
        logger.debug(
          { totalTokens: tokensStillNeedingPrices.length },
          "No tokens eligible for Google Sheets fallback"
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
      if (r.price !== "0") return false;

      const source = (r.source ?? "").toLowerCase();
      if (
        source.includes("tier_limitation") ||
        source.includes("unauthorized_access") ||
        source.includes("unavailable") ||
        source.includes("empty_response")
      ) {
        return true;
      }
      if (
        source.includes("network_error") ||
        source.includes("retryable_error")
      ) {
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
      "Caching price results to database"
    );

    const priceRecords: NewTokenPrice[] = results.map((result) => ({
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
      },
      "Price records to be cached"
    );

    try {
      await this.database
        .insert(tokenPrices)
        .values(priceRecords)
        .onConflictDoUpdate({
          target: [
            tokenPrices.tokenId,
            tokenPrices.baseTokenId,
            tokenPrices.timestamp,
          ],
          set: {
            price: sql`excluded.price`,
            source: sql`excluded.source`,
          },
        });
      logger.debug(
        { cachedCount: priceRecords.length },
        "Successfully cached price results to database"
      );
    } catch (error) {
      logger.error({ error, priceRecords }, "Failed to cache price results");
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
    if (error && typeof error === "object" && "code" in error) {
      const nodeError = error as { code: string };
      if (nodeError.code === "ECONNRESET" || nodeError.code === "ENOTFOUND") {
        return {
          shouldCache: false,
          cacheWindow: 0,
          sourcePrefix: "network_error",
        };
      }
    }

    if (
      response &&
      (response.status === 429 ||
        (response.status >= 500 && response.status < 600))
    ) {
      return {
        shouldCache: false,
        cacheWindow: 0,
        sourcePrefix: "retryable_error",
      };
    }

    if (response && response.status === 403) {
      return {
        shouldCache: true,
        cacheWindow: this.UNAVAILABLE_CACHE_MS,
        sourcePrefix: "tier_limitation",
        isTierLimitation: true,
      };
    }

    if (response && response.status === 401) {
      return {
        shouldCache: true,
        cacheWindow: this.UNAVAILABLE_CACHE_MS,
        sourcePrefix: "unauthorized_access",
        isTierLimitation: true,
      };
    }

    if (dataEmpty === true && response?.ok) {
      return {
        shouldCache: true,
        cacheWindow: this.RETRYABLE_FAILURE_CACHE_MS,
        sourcePrefix: "empty_response",
      };
    }

    if (response && response.status >= 400 && response.status < 500) {
      const isTierIssue =
        response.status === 404 && this.isPotentialTierLimitation(error);
      return {
        shouldCache: true,
        cacheWindow: this.UNAVAILABLE_CACHE_MS,
        sourcePrefix: isTierIssue ? "tier_limitation" : "unavailable",
        isTierLimitation: isTierIssue,
      };
    }

    return {
      shouldCache: true,
      cacheWindow: this.RETRYABLE_FAILURE_CACHE_MS,
      sourcePrefix: "unknown_error",
    };
  }

  private isPotentialTierLimitation(error: unknown): boolean {
    if (!(error instanceof Error)) return false;

    const message = error.message.toLowerCase();
    const tierKeywords = [
      "subscription",
      "plan",
      "tier",
      "premium",
      "upgrade",
      "access denied",
      "not authorized",
      "forbidden",
      "limit exceeded",
    ];

    return tierKeywords.some((keyword) => message.includes(keyword));
  }

  private tokenHasFinnhubMetadata(token: Token): boolean {
    try {
      const metadata = JSON.parse(token.providerMetadata || "{}");
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
    const cacheStrategy = this.shouldCacheFailure(
      error,
      options?.response,
      options?.dataEmpty
    );

    if (!cacheStrategy.shouldCache) {
      logger.debug(
        { error, tokenId, provider: providerName },
        `${providerName}: Not caching ${cacheStrategy.sourcePrefix}, will retry`
      );
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `${providerName} ${cacheStrategy.sourcePrefix}: ${errorMessage}`
      );
    }

    if (cacheStrategy.isTierLimitation) {
      this.updateTokenProviderMetadata(
        tokenId,
        providerName,
        cacheStrategy.sourcePrefix,
        error
      );
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
      price: "0",
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
      const result = await this.database
        .select()
        .from(tokens)
        .where(eq(tokens.id, tokenId))
        .limit(1);

      const token = result[0];
      if (!token) {
        logger.warn(`Token ${tokenId} not found for metadata update`);
        return;
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);

      let currentMetadata = {} as Record<string, unknown>;
      if (token.providerMetadata) {
        try {
          currentMetadata =
            typeof token.providerMetadata === "string"
              ? JSON.parse(token.providerMetadata)
              : (token.providerMetadata as Record<string, unknown>);
        } catch (parseError) {
          logger.warn(
            `Failed to parse existing metadata for token ${tokenId}: ${parseError}`
          );
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
          requiresPremium:
            sourcePrefix.includes("tier") ||
            sourcePrefix.includes("unauthorized"),
        },
      };

      await this.database
        .update(tokens)
        .set({
          providerMetadata: JSON.stringify(updatedMetadata),
          updatedAt: new Date(),
        })
        .where(eq(tokens.id, tokenId));

      logger.info(
        {
          tokenId,
          symbol: token.symbol,
          provider: providerName,
          sourcePrefix,
          requiresPremium: updatedMetadata.pricingUnavailable.requiresPremium,
        },
        "Updated token metadata for pricing limitation"
      );
    } catch (err) {
      logger.error(
        {
          tokenId,
          error: err instanceof Error ? err.message : String(err),
        },
        "Failed to update token metadata"
      );
    }
  }

  private async getTokenBySymbol(symbol: string): Promise<Token | null> {
    const result = await this.database
      .select()
      .from(tokens)
      .where(eq(tokens.symbol, symbol.toUpperCase()))
      .limit(1);

    return result[0] || null;
  }
}

export const pricingService = new PricingService();
