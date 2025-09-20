// Pricing Service - Clean Architecture Implementation

import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { config } from '../config/pricing';
import { db } from '../db/connection';
import type { NewTokenPrice, Token } from '../db/schema';
import { tokenPrices, tokens, tokenTypes } from '../db/schema';
import { logger } from '../utils/logger';

// ================================================================
// TYPES & INTERFACES
// ================================================================

interface CachedPrice {
  price: string;
  timestamp: Date;
  source: string;
}

interface TokenWithMetadata {
  token: Token;
  provider: string;
  providerTokenId?: string; // e.g., CoinGecko ID, Finnhub symbol
}

interface ProviderPriceResult {
  tokenId: string;
  price: string;
  timestamp: Date;
  source: string;
}

// Provider API Response Types
interface ExchangeRateApiResponse {
  base: string;
  date: string;
  time_last_updated: number;
  rates: Record<string, number>;
}

interface CoinGeckoPrice {
  [coinId: string]: {
    [currency: string]: number;
  };
}

interface FinnhubQuoteResponse {
  c: number; // Current price
  h: number; // High price of the day
  l: number; // Low price of the day
  o: number; // Open price of the day
  pc: number; // Previous close price
  t: number; // Timestamp
}

// Provider Configuration
const PROVIDER_CONFIGS = {
  exchangeRate: {
    name: 'ExchangeRate-API',
    baseUrl: 'https://api.exchangerate-api.com/v4/latest',
    rateLimit: 1500, // requests per month on free tier
  },
  coinGecko: {
    name: 'CoinGecko',
    baseUrl: 'https://api.coingecko.com/api/v3',
    rateLimit: 50, // requests per minute on free tier
  },
  finnhub: {
    name: 'Finnhub',
    baseUrl: 'https://finnhub.io/api/v1',
    rateLimit: 60, // requests per minute on free tier
  },
} as const;

// ================================================================
// RATE LIMITER CLASS
// ================================================================

class RateLimiter {
  private requestQueue: Array<() => void> = [];
  private requestTimes: number[] = [];
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.requestQueue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      this.processQueue();
    });
  }

  private processQueue(): void {
    if (this.requestQueue.length === 0) return;

    const now = Date.now();

    // Remove old request times outside the window
    this.requestTimes = this.requestTimes.filter((time) => now - time < this.windowMs);

    // If we have room for more requests, process the next one
    if (this.requestTimes.length < this.maxRequests) {
      const nextRequest = this.requestQueue.shift();
      if (nextRequest) {
        this.requestTimes.push(now);
        nextRequest();

        // Process more if possible
        setTimeout(() => this.processQueue(), 0);
      }
    } else {
      // Wait until we can make another request
      const oldestRequest = this.requestTimes[0];
      if (oldestRequest) {
        const waitTime = this.windowMs - (now - oldestRequest) + 100; // Add 100ms buffer
        setTimeout(() => this.processQueue(), waitTime);
      }
    }
  }
}

// ================================================================
// MAIN PRICING SERVICE
// ================================================================

export class PricingService {
  private readonly LIVE_PRICE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
  private readonly HISTORICAL_PRICE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
  // Failure caching windows - shorter for retryable failures
  private readonly UNAVAILABLE_CACHE_MS = 60 * 60 * 1000; // 1 hour for truly unavailable tokens
  private readonly RETRYABLE_FAILURE_CACHE_MS = 5 * 60 * 1000; // 5 minutes for potentially fixable issues

  // Rate limiters for each provider
  private readonly finnhubRateLimiter = new RateLimiter(50, 60 * 1000); // 50 req/min (conservative)
  private readonly coinGeckoRateLimiter = new RateLimiter(40, 60 * 1000); // 40 req/min (conservative)

  // Request deduplication to prevent concurrent identical requests
  private readonly ongoingRequests = new Map<string, Promise<Map<string, string>>>();

  // NO in-memory caching - all caching goes through database only

  constructor(private readonly database = db) {}

  // ================================================================
  // PUBLIC API METHODS
  // ================================================================

  /**
   * Get individual token price with cache-first approach
   */
  async getTokenPrice(token: Token, baseCurrencySymbol: string, timestamp: Date): Promise<string> {
    // Get base currency token
    const baseCurrencyToken = await this.getTokenBySymbol(baseCurrencySymbol);
    if (!baseCurrencyToken) {
      logger.warn({ baseCurrencySymbol }, 'Base currency token not found in getTokenPrice');
      return '0';
    }

    // Same currency check
    if (token.id === baseCurrencyToken.id) {
      return '1';
    }

    // Check cache first
    const cached = await this.getCachedPrice(token.id, baseCurrencyToken.id, timestamp);
    if (cached) {
      return cached.price;
    }

    // No cache - fetch from provider
    const tokensByProvider = await this.groupTokensByProvider([token]);
    const freshPrices = await this.fetchFromAllProviders(
      tokensByProvider,
      baseCurrencyToken,
      timestamp
    );

    // Return the fresh price or "0" if not found
    const priceResult = freshPrices.find((p) => p.tokenId === token.id);
    return priceResult?.price || '0';
  }

  /**
   * Get multiple token prices with optimized batch processing
   */
  async getTokenPrices(
    tokens: Token[],
    baseCurrencySymbol: string,
    timestamp: Date
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();

    if (tokens.length === 0) return results;

    // Generate deduplication key based on token IDs, base currency, and timestamp (rounded to minute)
    const tokenIds = tokens
      .map((t) => t.id)
      .sort()
      .join(',');
    const timestampMinute = Math.floor(timestamp.getTime() / (60 * 1000)) * 60 * 1000;
    const deduplicationKey = `getTokenPrices:${tokenIds}:${baseCurrencySymbol}:${timestampMinute}`;

    // Check if this exact request is already in progress
    const ongoingRequest = this.ongoingRequests.get(deduplicationKey);
    if (ongoingRequest) {
      logger.debug({ deduplicationKey }, 'Deduplicating concurrent getTokenPrices request');
      return await ongoingRequest;
    }

    // Create and store the promise for this request
    const requestPromise = (async (): Promise<Map<string, string>> => {
      try {
        // Get base currency token once
        const baseCurrencyToken = await this.getTokenBySymbol(baseCurrencySymbol);
        if (!baseCurrencyToken) {
          logger.warn({ baseCurrencySymbol }, 'Base currency token not found in getTokenPrices');
          // Return all prices as "0"
          for (const token of tokens) {
            results.set(token.id, '0');
          }
          return results;
        }

        // Handle same-currency tokens immediately
        const tokensToProcess = tokens.filter((token) => {
          if (token.id === baseCurrencyToken.id) {
            results.set(token.id, '1');
            return false;
          }
          return true;
        });

        if (tokensToProcess.length === 0) return results;

        // STEP 1: Single cache lookup for all tokens
        const cachedPrices = await this.getBatchCachedPrices(
          tokensToProcess.map((t) => t.id),
          baseCurrencyToken.id,
          timestamp
        );

        // STEP 2: Process cached results and collect tokens needing fresh prices
        const tokensNeedingPrices: Token[] = [];

        for (const token of tokensToProcess) {
          const cached = cachedPrices.get(token.id);
          if (cached) {
            // Use cached price (including "0" for unavailable tokens if still within cache window)
            results.set(token.id, cached.price);
          } else {
            // No cache entry - need to fetch from provider
            tokensNeedingPrices.push(token);
          }
        }

        // STEP 3: Fetch missing prices from providers (if any)
        if (tokensNeedingPrices.length > 0) {
          logger.info(
            {
              tokenCount: tokensNeedingPrices.length,
              cachedCount: tokensToProcess.length - tokensNeedingPrices.length,
              baseCurrency: baseCurrencySymbol,
            },
            'Fetching prices from external providers'
          );

          // Group tokens by provider
          const tokensByProvider = await this.groupTokensByProvider(tokensNeedingPrices);

          // Fetch from all providers concurrently
          const freshPrices = await this.fetchFromAllProviders(
            tokensByProvider,
            baseCurrencyToken,
            timestamp
          );

          // Add fresh prices to results
          for (const priceResult of freshPrices) {
            results.set(priceResult.tokenId, priceResult.price);
          }

          // If any tokens still don't have prices, set them to "0"
          for (const token of tokensNeedingPrices) {
            if (!results.has(token.id)) {
              results.set(token.id, '0');
            }
          }
        }

        return results;
      } finally {
        // Clean up the deduplication entry
        this.ongoingRequests.delete(deduplicationKey);
      }
    })();

    // Store the promise and return it
    this.ongoingRequests.set(deduplicationKey, requestPromise);
    return requestPromise;
  }

  /**
   * Lookup token by symbol from providers (for tokens not in our database)
   */
  async lookupToken(symbol: string): Promise<{
    symbol: string;
    name: string;
    provider: string;
    providerTokenId: string;
    tokenType: string;
  } | null> {
    // For now, return null - this will be implemented later with actual provider API calls
    // This method will search CoinGecko, Finnhub, etc. for tokens not in our database
    logger.info({ symbol }, 'Token lookup not yet implemented');
    return null;
  }

  // ================================================================
  // PRIVATE METHODS (placeholders)
  // ================================================================

  private async getCachedPrice(
    tokenId: string,
    baseCurrencyId: string,
    timestamp: Date
  ): Promise<CachedPrice | null> {
    const isLive = this.isLivePrice(timestamp);
    const maxAge = isLive ? this.LIVE_PRICE_WINDOW_MS : this.HISTORICAL_PRICE_WINDOW_MS;
    const minTimestamp = new Date(timestamp.getTime() - maxAge);

    const result = await this.database
      .select({
        price: tokenPrices.price,
        timestamp: tokenPrices.timestamp,
        source: tokenPrices.source,
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
        source: result[0].source || 'cached',
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
    const maxAge = isLive ? this.LIVE_PRICE_WINDOW_MS : this.HISTORICAL_PRICE_WINDOW_MS;
    const minTimestamp = new Date(timestamp.getTime() - maxAge);

    // SINGLE SQL QUERY using IN clause - much more efficient than OR conditions
    const cachedPrices = await this.database
      .select({
        tokenId: tokenPrices.tokenId,
        price: tokenPrices.price,
        timestamp: tokenPrices.timestamp,
        source: tokenPrices.source,
      })
      .from(tokenPrices)
      .where(
        and(
          inArray(tokenPrices.tokenId, tokenIds),
          eq(tokenPrices.baseTokenId, baseCurrencyId),
          gte(tokenPrices.timestamp, minTimestamp)
        )
      )
      .orderBy(desc(tokenPrices.timestamp));

    // Group by tokenId and take most recent for each
    const pricesByToken = new Map<string, (typeof cachedPrices)[0]>();
    for (const price of cachedPrices) {
      if (!pricesByToken.has(price.tokenId)) {
        pricesByToken.set(price.tokenId, price);
      }
    }

    // Convert to result format
    pricesByToken.forEach((price, tokenId) => {
      results.set(tokenId, {
        price: price.price,
        timestamp: price.timestamp,
        source: price.source || 'cached',
      });
    });

    return results;
  }

  /**
   * Get currency conversion rate from one currency to another
   * Uses ExchangeRate-API as the source of truth for all conversions
   * Caches rates for 1 hour to avoid repeated API calls
   */
  private async getCurrencyConversionRate(
    fromCurrency: string,
    toCurrency: string,
    _timestamp: Date
  ): Promise<string> {
    if (fromCurrency === toCurrency) {
      return '1';
    }

    // For currency conversion, we can just fetch fresh each time
    // Database caching for currency rates would require a different approach
    // and these rates change infrequently enough that it's not worth the complexity

    try {
      // Use ExchangeRate-API to get conversion rate
      const url = `${PROVIDER_CONFIGS.exchangeRate.baseUrl}/${fromCurrency}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(
          `ExchangeRate-API responded with ${response.status}: ${response.statusText}`
        );
      }

      const data = (await response.json()) as ExchangeRateApiResponse;

      if (!data.rates?.[toCurrency]) {
        throw new Error(`No conversion rate available from ${fromCurrency} to ${toCurrency}`);
      }

      const conversionRate = data.rates[toCurrency];
      const rateString = conversionRate.toString();

      logger.debug(
        { fromCurrency, toCurrency, rate: conversionRate },
        'Currency conversion rate fetched'
      );

      return rateString;
    } catch (error) {
      logger.warn({ fromCurrency, toCurrency, error }, 'Failed to get currency conversion rate');
      return '0';
    }
  }

  /**
   * Convert a price from one currency to another
   */
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
        return '0'; // Conversion failed
      }

      // Convert: originalPrice * conversionRate = priceInTargetCurrency
      const originalPrice = parseFloat(price);
      const rate = parseFloat(conversionRate);
      const convertedPrice = originalPrice * rate;

      logger.debug(
        {
          originalPrice,
          rate,
          convertedPrice,
          fromCurrency,
          toCurrency,
        },
        'Price converted'
      );

      return convertedPrice.toString();
    } catch (error) {
      logger.error({ error, price, fromCurrency, toCurrency }, 'Price conversion failed');
      return '0';
    }
  }

  private async groupTokensByProvider(
    tokensToGroup: Token[]
  ): Promise<Map<string, TokenWithMetadata[]>> {
    const groupedTokens = new Map<string, TokenWithMetadata[]>();

    if (tokensToGroup.length === 0) return groupedTokens;

    // Get token types for all tokens in one query
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

    // Create a lookup map for token type codes
    const typeCodeLookup = new Map<string, string>();
    for (const row of tokenTypesMap) {
      typeCodeLookup.set(row.tokenId, row.typeCode);
    }

    // Group tokens by provider based on token type
    for (const token of tokensToGroup) {
      const typeCode = typeCodeLookup.get(token.id);
      if (!typeCode) continue;

      let provider: string;
      let providerTokenId: string | undefined;

      // Determine provider based on token type
      switch (typeCode.toLowerCase()) {
        case 'fiat':
        case 'fiat_currency':
          provider = 'exchangeRate';
          providerTokenId = token.symbol; // USD, EUR, etc.
          break;

        case 'crypto':
        case 'cryptocurrency':
          provider = 'coinGecko';
          // Parse provider metadata for CoinGecko ID
          try {
            const metadata = JSON.parse(token.providerMetadata || '{}');
            providerTokenId =
              metadata.coingecko?.id || metadata.coinGeckoId || token.symbol.toLowerCase();
          } catch {
            providerTokenId = token.symbol.toLowerCase();
          }
          break;

        case 'stock':
        case 'etf':
        case 'mutual_fund':
        case 'equity':
          provider = 'finnhub';
          providerTokenId = token.symbol; // AAPL, SPY, etc.
          break;

        default:
          // Unknown token type, skip
          continue;
      }

      // Add to appropriate provider group
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

  /**
   * Fetch fiat exchange rates from ExchangeRate-API
   * Single API call gets all rates for the base currency
   */
  private async fetchExchangeRates(
    tokens: TokenWithMetadata[],
    baseCurrencySymbol: string,
    timestamp: Date
  ): Promise<ProviderPriceResult[]> {
    const results: ProviderPriceResult[] = [];

    if (tokens.length === 0) return results;

    try {
      const url = `${PROVIDER_CONFIGS.exchangeRate.baseUrl}/${baseCurrencySymbol}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(
          `ExchangeRate-API responded with ${response.status}: ${response.statusText}`
        );
      }

      const data = (await response.json()) as ExchangeRateApiResponse;

      if (!data.rates) {
        throw new Error('ExchangeRate-API returned no rates data');
      }

      // Process each token and find its rate
      for (const { token, providerTokenId } of tokens) {
        const symbol = (providerTokenId || token.symbol).toUpperCase();

        if (symbol === baseCurrencySymbol) {
          // Same currency = 1.0
          results.push({
            tokenId: token.id,
            price: '1.0',
            timestamp,
            source: PROVIDER_CONFIGS.exchangeRate.name,
          });
        } else if (data.rates[symbol]) {
          // Found exchange rate
          results.push({
            tokenId: token.id,
            price: data.rates[symbol].toString(),
            timestamp,
            source: PROVIDER_CONFIGS.exchangeRate.name,
          });
        } else {
          // No rate available - use intelligent caching
          results.push(
            this.createFailureResult(
              token.id,
              timestamp,
              PROVIDER_CONFIGS.exchangeRate.name,
              new Error('Currency rate not available'),
              response,
              false
            )
          );
        }
      }
    } catch (error) {
      logger.error({ error, provider: 'exchangeRate' }, 'ExchangeRate-API fetch failed');

      // Use intelligent failure handling for all tokens
      for (const { token } of tokens) {
        try {
          results.push(
            this.createFailureResult(
              token.id,
              timestamp,
              PROVIDER_CONFIGS.exchangeRate.name,
              error,
              undefined,
              false
            )
          );
        } catch (nonCacheableError) {
          // Skip non-cacheable errors
          logger.debug(
            { error: nonCacheableError, tokenId: token.id },
            'ExchangeRate: Skipping non-cacheable error'
          );
        }
      }
    }

    return results;
  }

  /**
   * Fetch cryptocurrency prices from CoinGecko API
   * Single API call gets prices for multiple coins at once
   * Dynamically handles currency conversion by trying base currency first, then USD fallback
   */
  private async fetchCoinGeckoPrices(
    tokens: TokenWithMetadata[],
    baseCurrencySymbol: string,
    timestamp: Date
  ): Promise<ProviderPriceResult[]> {
    const results: ProviderPriceResult[] = [];

    if (tokens.length === 0) return results;

    try {
      // Prepare coin IDs for batch request
      const coinIds = tokens
        .map(({ providerTokenId }) => providerTokenId)
        .filter(Boolean)
        .join(',');

      if (!coinIds) {
        throw new Error('No valid CoinGecko IDs found for tokens');
      }

      const baseCurrencyLower = baseCurrencySymbol.toLowerCase();
      let apiCurrency = baseCurrencyLower;
      let needsConversion = false;

      // First, try to get prices in the requested base currency
      let url = `${PROVIDER_CONFIGS.coinGecko.baseUrl}/simple/price?ids=${coinIds}&vs_currencies=${apiCurrency}`;

      logger.debug(
        { url, coinIds, baseCurrency: baseCurrencySymbol },
        'CoinGecko: Making rate-limited API request'
      );

      let response = await this.coinGeckoRateLimiter.execute(async () => {
        return await fetch(url);
      });

      if (!response.ok) {
        throw new Error(`CoinGecko API responded with ${response.status}: ${response.statusText}`);
      }

      let data = (await response.json()) as CoinGeckoPrice;

      logger.debug(
        { data, coinIds, responseKeys: Object.keys(data) },
        'CoinGecko: API response received'
      );

      // Check if any token has price data in the requested currency
      const hasDataInBaseCurrency = tokens.some(({ providerTokenId, token }) => {
        const coinId = providerTokenId || token.symbol.toLowerCase();
        return data[coinId]?.[apiCurrency] !== undefined;
      });

      // If no data in base currency and base currency is not USD, try USD
      if (!hasDataInBaseCurrency && baseCurrencyLower !== 'usd') {
        logger.debug(
          { baseCurrency: baseCurrencySymbol },
          'CoinGecko: Base currency not supported, trying USD fallback'
        );

        apiCurrency = 'usd';
        needsConversion = true;

        // Retry with USD
        url = `${PROVIDER_CONFIGS.coinGecko.baseUrl}/simple/price?ids=${coinIds}&vs_currencies=${apiCurrency}`;
        response = await this.coinGeckoRateLimiter.execute(async () => {
          return await fetch(url);
        });

        if (!response.ok) {
          throw new Error(
            `CoinGecko API responded with ${response.status}: ${response.statusText}`
          );
        }

        data = (await response.json()) as CoinGeckoPrice;
      }

      // Process each token and find its price
      for (const { token, providerTokenId } of tokens) {
        const coinId = providerTokenId || token.symbol.toLowerCase();
        const priceData = data[coinId];

        logger.debug(
          {
            tokenSymbol: token.symbol,
            coinId,
            providerTokenId,
            hasPrice: !!priceData?.[apiCurrency],
            priceData,
          },
          'CoinGecko: Processing token'
        );

        const priceValue = priceData?.[apiCurrency];
        if (priceValue !== undefined && priceValue !== null) {
          let finalPrice = priceValue.toString();

          // Convert price if needed
          if (needsConversion) {
            finalPrice = await this.convertPrice(
              finalPrice,
              'USD', // We fetched in USD
              baseCurrencySymbol.toUpperCase(),
              timestamp
            );

            if (finalPrice === '0') {
              // Conversion failed
              results.push({
                tokenId: token.id,
                price: '0',
                timestamp,
                source: `${PROVIDER_CONFIGS.coinGecko.name}_conversion_failed`,
              });
              continue;
            }
          }

          // Found and converted price
          results.push({
            tokenId: token.id,
            price: finalPrice,
            timestamp,
            source: PROVIDER_CONFIGS.coinGecko.name,
          });
        } else {
          // No price available - use intelligent caching
          results.push(
            this.createFailureResult(
              token.id,
              timestamp,
              PROVIDER_CONFIGS.coinGecko.name,
              new Error('No price data available for token'),
              response,
              true // dataEmpty = true
            )
          );
        }
      }
    } catch (error) {
      logger.error({ error, provider: 'coinGecko' }, 'CoinGecko API fetch failed');

      // Use intelligent failure handling for all tokens
      for (const { token } of tokens) {
        try {
          results.push(
            this.createFailureResult(
              token.id,
              timestamp,
              PROVIDER_CONFIGS.coinGecko.name,
              error,
              undefined, // no response available
              false
            )
          );
        } catch (nonCacheableError) {
          // If error is not cacheable, we skip this token and will retry later
          logger.debug(
            { error: nonCacheableError, tokenId: token.id },
            'CoinGecko: Skipping non-cacheable error'
          );
        }
      }
    }

    return results;
  }

  /**
   * Fetch stock/ETF prices from Finnhub API
   * Multiple API calls but batched by making them concurrent
   * Handles currency conversion since Finnhub only provides USD prices
   */
  private async fetchFinnhubPrices(
    tokens: TokenWithMetadata[],
    baseCurrencySymbol: string,
    timestamp: Date
  ): Promise<ProviderPriceResult[]> {
    const results: ProviderPriceResult[] = [];

    if (tokens.length === 0) return results;

    try {
      // Check if we need currency conversion (Finnhub provides USD prices)
      const baseCurrencyUpper = baseCurrencySymbol.toUpperCase();
      const needsConversion = baseCurrencyUpper !== 'USD';

      if (needsConversion) {
        logger.debug(
          { baseCurrency: baseCurrencySymbol },
          'Finnhub: Base currency not supported, will convert from USD'
        );
      }

      // Finnhub doesn't have a batch endpoint, so we make rate-limited individual requests
      const promises = tokens.map(async ({ token, providerTokenId }) => {
        try {
          const symbol = (providerTokenId || token.symbol).toUpperCase();

          const response = await this.finnhubRateLimiter.execute(async () => {
            const url = `${PROVIDER_CONFIGS.finnhub.baseUrl}/quote?symbol=${symbol}&token=${config.finnhub.apiKey}`;
            logger.debug({ symbol, url }, 'Finnhub: Making rate-limited API request');
            return await fetch(url);
          });

          if (!response.ok) {
            // Handle API failures with response context
            return this.createFailureResult(
              token.id,
              timestamp,
              PROVIDER_CONFIGS.finnhub.name,
              new Error(`Finnhub API responded with ${response.status} for ${symbol}`),
              response, // Pass the response so tier limitations can be detected
              false
            );
          }

          const data = (await response.json()) as FinnhubQuoteResponse;

          // Check if we got valid data (current price exists)
          if (data.c && data.c > 0) {
            let finalPrice = data.c.toString();

            // Convert price if needed
            if (needsConversion) {
              finalPrice = await this.convertPrice(
                finalPrice,
                'USD', // Finnhub provides USD prices
                baseCurrencyUpper,
                timestamp
              );

              if (finalPrice === '0') {
                // Conversion failed
                return {
                  tokenId: token.id,
                  price: '0',
                  timestamp,
                  source: `${PROVIDER_CONFIGS.finnhub.name}_conversion_failed`,
                };
              }
            }

            return {
              tokenId: token.id,
              price: finalPrice,
              timestamp,
              source: PROVIDER_CONFIGS.finnhub.name,
            };
          } else {
            // No valid price data - check if it's truly unavailable or API issue
            return this.createFailureResult(
              token.id,
              timestamp,
              PROVIDER_CONFIGS.finnhub.name,
              new Error('No valid price data from Finnhub'),
              response,
              false // not necessarily empty response
            );
          }
        } catch (error) {
          logger.error(
            { error, symbol: token.symbol, provider: 'finnhub' },
            'Finnhub fetch failed for token'
          );
          try {
            return this.createFailureResult(
              token.id,
              timestamp,
              PROVIDER_CONFIGS.finnhub.name,
              error,
              undefined, // no response in catch
              false
            );
          } catch (nonCacheableError) {
            // If error is not cacheable, return error result anyway for consistency
            logger.debug(
              { error: nonCacheableError, tokenId: token.id },
              'Finnhub: Error not cacheable, but returning result anyway'
            );
            throw error; // This will be caught by Promise.all and may cause partial failures
          }
        }
      });

      // Wait for all requests to complete
      const fetchResults = await Promise.all(promises);
      results.push(...fetchResults);
    } catch (error) {
      logger.error({ error, provider: 'finnhub' }, 'Finnhub API batch fetch failed');

      // Use intelligent failure handling for all tokens
      for (const { token } of tokens) {
        try {
          results.push(
            this.createFailureResult(
              token.id,
              timestamp,
              PROVIDER_CONFIGS.finnhub.name,
              error,
              undefined,
              false
            )
          );
        } catch (nonCacheableError) {
          // Skip non-cacheable errors
          logger.debug(
            { error: nonCacheableError, tokenId: token.id },
            'Finnhub: Skipping non-cacheable batch error'
          );
        }
      }
    }

    return results;
  }

  private async fetchFromAllProviders(
    tokensByProvider: Map<string, TokenWithMetadata[]>,
    baseCurrencyToken: Token,
    timestamp: Date
  ): Promise<ProviderPriceResult[]> {
    const allResults: ProviderPriceResult[] = [];

    // Execute all provider calls concurrently for maximum efficiency
    const providerPromises: Promise<ProviderPriceResult[]>[] = [];

    // ExchangeRate-API for fiat currencies
    const exchangeRateTokens = tokensByProvider.get('exchangeRate');
    if (exchangeRateTokens && exchangeRateTokens.length > 0) {
      providerPromises.push(
        this.fetchExchangeRates(exchangeRateTokens, baseCurrencyToken.symbol, timestamp)
      );
    }

    // CoinGecko for cryptocurrencies
    const coinGeckoTokens = tokensByProvider.get('coinGecko');
    if (coinGeckoTokens && coinGeckoTokens.length > 0) {
      providerPromises.push(
        this.fetchCoinGeckoPrices(coinGeckoTokens, baseCurrencyToken.symbol, timestamp)
      );
    }

    // Finnhub for stocks/ETFs
    const finnhubTokens = tokensByProvider.get('finnhub');
    if (finnhubTokens && finnhubTokens.length > 0) {
      providerPromises.push(
        this.fetchFinnhubPrices(finnhubTokens, baseCurrencyToken.symbol, timestamp)
      );
    }

    // Wait for all provider calls to complete
    try {
      const providerResults = await Promise.all(providerPromises);

      // Flatten all results into a single array
      for (const results of providerResults) {
        allResults.push(...results);
      }
    } catch (error) {
      logger.error({ error }, 'One or more provider calls failed');
      // Individual provider methods already handle their own errors,
      // so this should rarely happen, but we log it just in case
    }

    // Cache all results to database (including unavailable/error results)
    await this.cachePriceResults(allResults, baseCurrencyToken.id);

    return allResults;
  }

  /**
   * Cache price results to database for future lookups
   * This includes unavailable/error results to prevent repeated API calls
   */
  private async cachePriceResults(
    results: ProviderPriceResult[],
    baseCurrencyId: string
  ): Promise<void> {
    if (results.length === 0) return;

    const priceRecords: NewTokenPrice[] = results.map((result) => ({
      tokenId: result.tokenId,
      baseTokenId: baseCurrencyId,
      price: result.price,
      timestamp: result.timestamp,
      source: result.source,
    }));

    try {
      await this.database.insert(tokenPrices).values(priceRecords);
    } catch (error) {
      logger.error({ error }, 'Failed to cache price results');
      // Don't throw - this is a performance optimization, not critical
    }
  }

  private isLivePrice(timestamp: Date): boolean {
    const now = new Date();
    const diffMs = now.getTime() - timestamp.getTime();
    return diffMs < 2 * 60 * 60 * 1000; // Within 2 hours considered "live"
  }

  /**
   * Determine if a failure should be cached or retried
   */
  private shouldCacheFailure(
    error: Error | unknown,
    response?: Response,
    dataEmpty?: boolean
  ): {
    shouldCache: boolean;
    cacheWindow: number;
    sourcePrefix: string;
    isTierLimitation?: boolean;
  } {
    // Don't cache network/temporary failures
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

    // Don't cache rate limiting (429) or server errors (5xx)
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

    // Handle API tier limitations - 403 Forbidden typically means access denied due to plan restrictions
    if (response && response.status === 403) {
      return {
        shouldCache: true,
        cacheWindow: this.UNAVAILABLE_CACHE_MS,
        sourcePrefix: 'tier_limitation',
        isTierLimitation: true,
      };
    }

    // Handle 401 Unauthorized - could be API key issue or tier limitation
    if (response && response.status === 401) {
      return {
        shouldCache: true,
        cacheWindow: this.UNAVAILABLE_CACHE_MS,
        sourcePrefix: 'unauthorized_access',
        isTierLimitation: true,
      };
    }

    // Don't cache empty responses (likely wrong token ID)
    if (dataEmpty === true && response?.ok) {
      return {
        shouldCache: true,
        cacheWindow: this.RETRYABLE_FAILURE_CACHE_MS,
        sourcePrefix: 'empty_response',
      };
    }

    // Cache client errors (4xx) as truly unavailable, but check if it might be tier-related
    if (response && response.status >= 400 && response.status < 500) {
      // 404 might be token not found, but could also be tier limitation for some providers
      const isTierIssue = response.status === 404 && this.isPotentialTierLimitation(error);
      return {
        shouldCache: true,
        cacheWindow: this.UNAVAILABLE_CACHE_MS,
        sourcePrefix: isTierIssue ? 'tier_limitation' : 'unavailable',
        isTierLimitation: isTierIssue,
      };
    }

    // Default: cache with short window for unknown failures
    return {
      shouldCache: true,
      cacheWindow: this.RETRYABLE_FAILURE_CACHE_MS,
      sourcePrefix: 'unknown_error',
    };
  }

  /**
   * Check if an error might be due to tier limitations based on error message
   */
  private isPotentialTierLimitation(error: Error | unknown): boolean {
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

  /**
   * Create a failure result with appropriate caching strategy
   */
  private createFailureResult(
    tokenId: string,
    timestamp: Date,
    providerName: string,
    error: Error | unknown,
    response?: Response,
    dataEmpty?: boolean
  ): ProviderPriceResult {
    const cacheStrategy = this.shouldCacheFailure(error, response, dataEmpty);

    if (!cacheStrategy.shouldCache) {
      // Don't save to database for non-cacheable failures
      logger.debug(
        { error, tokenId, provider: providerName },
        `${providerName}: Not caching ${cacheStrategy.sourcePrefix}, will retry`
      );
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`${providerName} ${cacheStrategy.sourcePrefix}: ${errorMessage}`);
    }

    // Update token metadata if this is a tier limitation (async, don't wait)
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
      },
      `${providerName}: Caching ${cacheStrategy.sourcePrefix} for ${cacheStrategy.cacheWindow}ms`
    );

    return {
      tokenId,
      price: '0',
      timestamp,
      source: `${providerName}_${cacheStrategy.sourcePrefix}`,
    };
  }

  /**
   * Update token metadata to record provider limitations
   */
  private async updateTokenProviderMetadata(
    tokenId: string,
    providerName: string,
    sourcePrefix: string,
    error: Error | unknown
  ): Promise<void> {
    try {
      // Get current token
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

      const errorMessage = error instanceof Error ? error.message : String(error);

      // Parse existing metadata or create new
      let currentMetadata = {};
      if (token.providerMetadata) {
        try {
          currentMetadata =
            typeof token.providerMetadata === 'string'
              ? JSON.parse(token.providerMetadata)
              : token.providerMetadata;
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

      // Update token with new metadata
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

  private async getTokenBySymbol(symbol: string): Promise<Token | null> {
    const result = await this.database
      .select()
      .from(tokens)
      .where(eq(tokens.symbol, symbol.toUpperCase()))
      .limit(1);

    return result[0] || null;
  }
}

// ================================================================
// SINGLETON INSTANCE
// ================================================================

export const pricingService = new PricingService();
