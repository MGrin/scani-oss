// Pricing Service - Clean Architecture Implementation

import Decimal from "decimal.js";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { google } from "googleapis";
import { config } from "../config/pricing";
import { db } from "../db/connection";
import type { NewTokenPrice, Token } from "../db/schema";
import { tokenPrices, tokens, tokenTypes } from "../db/schema";
import { logger } from "../utils/logger";

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
  c: number; // current price
  d: number; // change
  dp: number; // percent change
  h: number; // high
  l: number; // low
  o: number; // open
  pc: number; // previous close
  t: number; // timestamp
}

interface FinnhubProfileResponse {
  country: string;
  currency: string;
  exchange: string;
  ipo: string;
  marketCapitalization: number;
  name: string;
  phone: string;
  shareOutstanding: number;
  ticker: string;
  weburl: string;
  logo: string;
  finnhubIndustry: string;
}

interface CachedExchangeInfo {
  currency: string;
  exchange: string;
  mic: string;
}

// Provider Configuration
const PROVIDER_CONFIGS = {
  exchangeRate: {
    name: "ExchangeRate-API",
    baseUrl: "https://api.exchangerate-api.com/v4/latest",
    rateLimit: 1500, // requests per month on free tier
  },
  coinGecko: {
    name: "CoinGecko",
    baseUrl: "https://api.coingecko.com/api/v3",
    rateLimit: 50, // requests per minute on free tier
  },
  finnhub: {
    name: "Finnhub",
    baseUrl: "https://finnhub.io/api/v1",
    rateLimit: 60, // requests per minute on free tier
  },
  googleSheets: {
    name: "Google Sheets (GOOGLEFINANCE)",
    rateLimit: 100, // requests per 100 seconds per user
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
    this.requestTimes = this.requestTimes.filter(
      (time) => now - time < this.windowMs
    );

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
// UTILITY FUNCTIONS
// ================================================================

/**
 * Parse numeric values from Google Sheets that may use international number formats
 * Handles both US format (123.45) and European format (123,45)
 */
function parseInternationalNumber(
  value: string | null | undefined
): number | null {
  if (!value || typeof value !== "string") {
    return null;
  }

  // Remove any whitespace
  const cleaned = value.trim();

  if (!cleaned) {
    return null;
  }

  // Try parsing as-is first (handles US format and integers)
  let parsed = Number(cleaned);
  if (!Number.isNaN(parsed)) {
    return parsed;
  }

  // Handle European format: replace comma with dot for decimal separator
  const europeanFormat = cleaned.replace(",", ".");
  parsed = Number(europeanFormat);
  if (!Number.isNaN(parsed)) {
    return parsed;
  }

  // If still can't parse, return null
  return null;
}

/**
 * Check if a value represents a valid positive price
 */
function isValidPrice(value: string | null | undefined): boolean {
  const parsed = parseInternationalNumber(value);
  return parsed !== null && parsed > 0;
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
  private readonly googleSheetsRateLimiter = new RateLimiter(100, 100 * 1000); // 100 req/100s (Google Sheets quota)

  // Request deduplication to prevent concurrent identical requests
  private readonly ongoingRequests = new Map<
    string,
    Promise<Map<string, string>>
  >();

  // Google Sheets integration state
  private readonly googleSheetsAvailable: boolean;
  private googleSheetsCredentials: Record<string, unknown> | null = null;

  // PostgreSQL advisory lock ID for Google Sheets operations
  private readonly GOOGLE_SHEETS_LOCK_ID = 123456789; // Unique lock ID for Google Sheets operations

  // NO in-memory caching - all caching goes through database only

  constructor(private readonly database = db) {
    // Check Google Sheets availability on initialization
    this.googleSheetsAvailable = this.validateGoogleSheetsConfig();
  }

  /**
   * Try to acquire a PostgreSQL advisory lock for Google Sheets operations with timeout
   * This prevents multiple API instances from creating row assignment conflicts
   * Uses non-blocking lock with retry to prevent deadlocks
   */
  private async tryAcquireGoogleSheetsLock(
    timeoutMs: number = 5000
  ): Promise<boolean> {
    const startTime = Date.now();

    logger.debug(
      { lockId: this.GOOGLE_SHEETS_LOCK_ID, timeoutMs },
      "Attempting to acquire Google Sheets advisory lock with timeout"
    );

    while (Date.now() - startTime < timeoutMs) {
      try {
        // Use pg_try_advisory_lock which returns immediately
        const result = await this.database.execute(
          `SELECT pg_try_advisory_lock(${this.GOOGLE_SHEETS_LOCK_ID}) as acquired`
        );

        const acquired = result[0]?.acquired;
        if (acquired) {
          logger.debug(
            { lockId: this.GOOGLE_SHEETS_LOCK_ID },
            "Google Sheets advisory lock acquired"
          );
          return true;
        }

        // Wait a bit before retrying
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        logger.warn(
          { error, lockId: this.GOOGLE_SHEETS_LOCK_ID },
          "Failed to acquire Google Sheets advisory lock"
        );
        break;
      }
    }

    logger.warn(
      { lockId: this.GOOGLE_SHEETS_LOCK_ID, timeoutMs },
      "Failed to acquire Google Sheets advisory lock within timeout"
    );
    return false;
  }

  /**
   * Release the PostgreSQL advisory lock for Google Sheets operations
   */
  private async releaseGoogleSheetsLock(): Promise<void> {
    logger.debug(
      { lockId: this.GOOGLE_SHEETS_LOCK_ID },
      "Releasing Google Sheets advisory lock"
    );

    try {
      await this.database.execute(
        `SELECT pg_advisory_unlock(${this.GOOGLE_SHEETS_LOCK_ID})`
      );

      logger.debug(
        { lockId: this.GOOGLE_SHEETS_LOCK_ID },
        "Google Sheets advisory lock released"
      );
    } catch (error) {
      logger.warn(
        { error, lockId: this.GOOGLE_SHEETS_LOCK_ID },
        "Failed to release Google Sheets advisory lock (may have been already released)"
      );
    }
  }

  /**
   * Execute a function with Google Sheets advisory lock protection
   * Falls back to proceeding without lock if acquisition fails to prevent deadlocks
   */
  private async withGoogleSheetsLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockAcquired = await this.tryAcquireGoogleSheetsLock();

    if (!lockAcquired) {
      logger.warn(
        "Proceeding with Google Sheets operation without lock to prevent deadlock"
      );
      // Proceed without lock to prevent deadlock - better to have slight race condition
      // than to block the entire application
      return await fn();
    }

    try {
      return await fn();
    } finally {
      await this.releaseGoogleSheetsLock();
    }
  }

  /**
   * Validate Google Sheets configuration and initialize credentials
   */
  private validateGoogleSheetsConfig(): boolean {
    if (
      !process.env.GOOGLE_SHEETS_ID ||
      !process.env.GOOGLE_SERVICE_ACCOUNT_KEY
    ) {
      logger.info("Google Sheets not configured - fallback provider disabled");
      return false;
    }

    try {
      // Decode base64 encoded service account key
      const decodedKey = Buffer.from(
        process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
        "base64"
      ).toString("utf-8");
      this.googleSheetsCredentials = JSON.parse(decodedKey);
      logger.info("Google Sheets fallback provider initialized successfully");
      return true;
    } catch (error) {
      logger.warn(
        { error },
        "Failed to parse Google Sheets service account key - fallback provider disabled"
      );
      return false;
    }
  }

  // ================================================================
  // PUBLIC API METHODS
  // ================================================================

  /**
   * Get individual token price with cache-first approach
   */
  async getTokenPrice(
    token: Token,
    baseCurrencySymbol: string,
    timestamp: Date
  ): Promise<string> {
    // Get base currency token
    const baseCurrencyToken = await this.getTokenBySymbol(baseCurrencySymbol);
    if (!baseCurrencyToken) {
      logger.warn(
        { baseCurrencySymbol },
        "Base currency token not found in getTokenPrice"
      );
      return "0";
    }

    // Same currency check
    if (token.id === baseCurrencyToken.id) {
      return "1";
    }

    // Check cache first
    const cached = await this.getCachedPrice(
      token.id,
      baseCurrencyToken.id,
      timestamp
    );

    // If cached and it's a valid price (not "0"), return it
    if (cached && cached.price !== "0") {
      return cached.price;
    }

    // For tokens with Finnhub metadata that have cached failures,
    // we want to be more aggressive about trying Google Sheets fallback
    const hasFailedFinnhubCache =
      cached && cached.price === "0" && cached.source?.includes("Finnhub");
    const hasFinnhubMetadata = this.tokenHasFinnhubMetadata(token);

    if (
      hasFailedFinnhubCache &&
      hasFinnhubMetadata &&
      this.googleSheetsAvailable
    ) {
      logger.info(
        {
          tokenId: token.id,
          symbol: token.symbol,
          cachedSource: cached.source,
        },
        "Token has failed Finnhub cache but Finnhub metadata - forcing fresh fetch with Google Sheets fallback"
      );
    }

    // No valid cache (either no cache or cached failure) - fetch from provider
    const tokensByProvider = await this.groupTokensByProvider([token]);
    const freshPrices = await this.fetchFromAllProviders(
      tokensByProvider,
      baseCurrencyToken,
      timestamp
    );

    // Return the fresh price or "0" if not found
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
      .join(",");
    const timestampMinute =
      Math.floor(timestamp.getTime() / (60 * 1000)) * 60 * 1000;
    const deduplicationKey = `getTokenPrices:${tokenIds}:${baseCurrencySymbol}:${timestampMinute}`;

    // Check if this exact request is already in progress
    const ongoingRequest = this.ongoingRequests.get(deduplicationKey);
    if (ongoingRequest) {
      logger.debug(
        { deduplicationKey },
        "Deduplicating concurrent getTokenPrices request"
      );
      return await ongoingRequest;
    }

    // Create and store the promise for this request
    const requestPromise = (async (): Promise<Map<string, string>> => {
      try {
        // Get base currency token once
        const baseCurrencyToken = await this.getTokenBySymbol(
          baseCurrencySymbol
        );
        if (!baseCurrencyToken) {
          logger.warn(
            { baseCurrencySymbol },
            "Base currency token not found in getTokenPrices"
          );
          // Return all prices as "0"
          for (const token of tokens) {
            results.set(token.id, "0");
          }
          return results;
        }

        // Handle same-currency tokens immediately
        const tokensToProcess = tokens.filter((token) => {
          if (token.id === baseCurrencyToken.id) {
            results.set(token.id, "1");
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
            "Fetching prices from external providers"
          );

          // Group tokens by provider
          const tokensByProvider = await this.groupTokensByProvider(
            tokensNeedingPrices
          );

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

          // Check for tokens that still need prices and try Google Sheets as fallback
          // Only apply Google Sheets fallback to Finnhub tokens (stocks/ETFs)
          const tokensStillNeedingPrices = tokensNeedingPrices.filter(
            (token) => !results.has(token.id) || results.get(token.id) === "0"
          );

          if (
            tokensStillNeedingPrices.length > 0 &&
            this.googleSheetsAvailable
          ) {
            // Filter to only include Finnhub tokens for Google Sheets fallback
            const finnhubTokensForGoogleSheets = await this.filterFinnhubTokens(
              tokensStillNeedingPrices
            );

            if (finnhubTokensForGoogleSheets.length > 0) {
              logger.info(
                {
                  tokenCount: finnhubTokensForGoogleSheets.length,
                  totalNeedingPrices: tokensStillNeedingPrices.length,
                },
                "Trying Google Sheets fallback for Finnhub tokens without prices"
              );

              try {
                const googleSheetsTokens = finnhubTokensForGoogleSheets.map(
                  (token) => ({
                    token,
                    provider: "googleSheets" as const,
                  })
                );

                const googleSheetsPrices = await this.fetchGoogleSheetsPrices(
                  googleSheetsTokens,
                  baseCurrencyToken.symbol,
                  timestamp
                );

                // Cache Google Sheets prices
                if (googleSheetsPrices.length > 0) {
                  await this.cachePriceResults(
                    googleSheetsPrices,
                    baseCurrencyToken.id
                  );
                }

                // Add Google Sheets prices to results
                for (const priceResult of googleSheetsPrices) {
                  if (priceResult.price !== "0") {
                    // Only use if we got a real price
                    results.set(priceResult.tokenId, priceResult.price);
                  }
                }
              } catch (error) {
                logger.warn({ error }, "Google Sheets fallback failed");
              }
            } else {
              logger.debug(
                { totalTokens: tokensStillNeedingPrices.length },
                "No Finnhub tokens found for Google Sheets fallback"
              );
            }
          }

          // If any tokens still don't have prices after all providers (including Google Sheets), set them to "0"
          for (const token of tokensNeedingPrices) {
            if (!results.has(token.id)) {
              results.set(token.id, "0");
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
    logger.info({ symbol }, "Token lookup not yet implemented");
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
    const maxAge = isLive
      ? this.LIVE_PRICE_WINDOW_MS
      : this.HISTORICAL_PRICE_WINDOW_MS;
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
        source: result[0].source || "cached",
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
        source: price.source || "cached",
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
      return "1";
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

      return rateString;
    } catch (error) {
      logger.warn(
        { fromCurrency, toCurrency, error },
        "Failed to get currency conversion rate"
      );
      return "0";
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
        return "0"; // Conversion failed
      }

      // If the rate is suspiciously large (e.g., >10), invert it
      // This handles cases like IDR→USD where API returns 16642 (should be 1/16642)
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

    // Group tokens by provider based on token type AND provider metadata
    for (const token of tokensToGroup) {
      const typeCode = typeCodeLookup.get(token.id);
      if (!typeCode) continue;

      let provider: string;
      let providerTokenId: string | undefined;

      // First, check if token has explicit provider metadata that should override type-based assignment
      try {
        const metadata = JSON.parse(token.providerMetadata || "{}");

        // Check for Finnhub metadata (highest priority for equity-like tokens)
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
        }
        // Check for CoinGecko metadata
        else if (metadata.coingecko?.id || metadata.coinGeckoId) {
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
        }
        // If no specific provider metadata, fall back to type-based assignment
        else {
          const assignedProvider = this.getProviderByTokenType(typeCode, token);
          if (!assignedProvider) continue; // Skip tokens that can't be assigned
          provider = assignedProvider;
          providerTokenId = this.getProviderTokenId(provider, token, metadata);
        }
      } catch (error) {
        // If metadata parsing fails, fall back to type-based assignment
        logger.warn(
          {
            tokenId: token.id,
            symbol: token.symbol,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to parse provider metadata, using type-based provider assignment"
        );
        const assignedProvider = this.getProviderByTokenType(typeCode, token);
        if (!assignedProvider) continue; // Skip tokens that can't be assigned
        provider = assignedProvider;
        providerTokenId = this.getProviderTokenId(provider, token, {});
      }

      // Skip tokens that couldn't be assigned to any provider
      if (!provider) continue;

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
   * Get provider based on token type (fallback when no provider metadata available)
   */
  private getProviderByTokenType(
    typeCode: string,
    token: Token
  ): string | null {
    switch (typeCode.toLowerCase()) {
      case "fiat":
      case "fiat_currency":
        return "exchangeRate";

      case "crypto":
      case "cryptocurrency":
        return "coinGecko";

      case "stock":
      case "etf":
      case "mutual_fund":
      case "equity":
        return "finnhub";

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

  /**
   * Get provider-specific token ID based on provider and metadata
   */
  private getProviderTokenId(
    provider: string,
    token: Token,
    metadata: Record<string, unknown>
  ): string {
    switch (provider) {
      case "exchangeRate": {
        return token.symbol; // USD, EUR, etc.
      }

      case "coinGecko": {
        // Safely access nested metadata properties
        const coinGeckoData = metadata.coingecko as { id?: string } | undefined;
        const coinGeckoId = metadata.coinGeckoId as string | undefined;
        return coinGeckoData?.id || coinGeckoId || token.symbol.toLowerCase();
      }

      case "finnhub": {
        // Safely access nested metadata properties
        const finnhubData = metadata.finnhub as { symbol?: string } | undefined;
        return finnhubData?.symbol || token.symbol; // Use Finnhub symbol if available, otherwise token symbol
      }

      default: {
        return token.symbol;
      }
    }
  }

  /**
   * Filter tokens to only include those that would use Finnhub provider
   * This includes tokens with Finnhub-compatible types AND tokens with Finnhub provider metadata
   */
  private async filterFinnhubTokens(tokensToFilter: Token[]): Promise<Token[]> {
    if (tokensToFilter.length === 0) return [];

    // Get token types for filtering
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
          tokensToFilter.map((t) => t.id)
        )
      );

    // Create lookup map for token types
    const typeCodeLookup = new Map<string, string>();
    for (const row of tokenTypesMap) {
      typeCodeLookup.set(row.tokenId, row.typeCode);
    }

    // Filter to only Finnhub token types (stocks, ETFs, etc.) OR tokens with Finnhub metadata
    const finnhubTokenTypes = ["stock", "etf", "mutual_fund", "equity"];

    return tokensToFilter.filter((token) => {
      const typeCode = typeCodeLookup.get(token.id);

      // Include if token type is Finnhub-compatible
      if (typeCode && finnhubTokenTypes.includes(typeCode.toLowerCase())) {
        return true;
      }

      // Also include if token has Finnhub provider metadata (regardless of type)
      // This handles tokens created from screenshot parsing with Finnhub provider data
      try {
        const metadata = JSON.parse(token.providerMetadata || "{}");
        if (metadata.finnhub?.symbol) {
          logger.info(
            {
              tokenId: token.id,
              symbol: token.symbol,
              typeCode,
              finnhubSymbol: metadata.finnhub.symbol,
            },
            "Including token with Finnhub metadata for Google Sheets fallback (filterFinnhubTokens)"
          );
          return true;
        }
      } catch (error) {
        logger.warn(
          {
            tokenId: token.id,
            symbol: token.symbol,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to parse provider metadata in filterFinnhubTokens"
        );
      }

      return false;
    });
  }

  /**
   * Filter tokens that are eligible for Google Sheets pricing
   * This includes Finnhub-type tokens AND tokens with Finnhub provider metadata
   */
  private async filterTokensForGoogleSheets(
    tokensToFilter: Token[]
  ): Promise<Token[]> {
    if (tokensToFilter.length === 0) return [];

    logger.debug(
      {
        totalTokens: tokensToFilter.length,
        tokens: tokensToFilter.map((t) => ({
          id: t.id,
          symbol: t.symbol,
          hasProviderMetadata: !!t.providerMetadata,
        })),
      },
      "Starting Google Sheets token filtering"
    );

    // Get token types for filtering
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
          tokensToFilter.map((t) => t.id)
        )
      );

    // Create lookup map for token types
    const typeCodeLookup = new Map<string, string>();
    for (const row of tokenTypesMap) {
      typeCodeLookup.set(row.tokenId, row.typeCode);
    }

    // Stock/equity-like token types that Google Sheets can price
    const googleSheetsCompatibleTypes = [
      "stock",
      "etf",
      "mutual_fund",
      "equity",
    ];

    const eligibleTokens = tokensToFilter.filter((token) => {
      const typeCode = typeCodeLookup.get(token.id);

      logger.debug(
        {
          tokenId: token.id,
          symbol: token.symbol,
          typeCode,
          providerMetadata: token.providerMetadata,
        },
        "Evaluating token for Google Sheets eligibility"
      );

      // Include if token type is compatible
      if (
        typeCode &&
        googleSheetsCompatibleTypes.includes(typeCode.toLowerCase())
      ) {
        logger.info(
          {
            tokenId: token.id,
            symbol: token.symbol,
            typeCode,
          },
          "Including token due to compatible type for Google Sheets"
        );
        return true;
      }

      // Also include if token has Finnhub metadata (regardless of type)
      // This handles tokens created from screenshot parsing with Finnhub provider data
      try {
        const metadata = JSON.parse(token.providerMetadata || "{}");

        logger.debug(
          {
            tokenId: token.id,
            symbol: token.symbol,
            metadata,
            hasFinnhub: !!metadata.finnhub,
            finnhubSymbol: metadata.finnhub?.symbol,
          },
          "Checking token provider metadata for Finnhub"
        );

        if (metadata.finnhub?.symbol) {
          logger.info(
            {
              tokenId: token.id,
              symbol: token.symbol,
              finnhubSymbol: metadata.finnhub.symbol,
            },
            "Including token with Finnhub metadata for Google Sheets fallback"
          );
          return true;
        }
      } catch (error) {
        logger.warn(
          {
            tokenId: token.id,
            symbol: token.symbol,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to parse provider metadata"
        );
      }

      logger.debug(
        {
          tokenId: token.id,
          symbol: token.symbol,
          typeCode,
        },
        "Excluding token from Google Sheets - no compatible type or Finnhub metadata"
      );

      return false;
    });

    logger.info(
      {
        totalTokens: tokensToFilter.length,
        eligibleTokens: eligibleTokens.length,
        eligibleSymbols: eligibleTokens.map((t) => t.symbol),
      },
      "Google Sheets token filtering completed"
    );

    return eligibleTokens;
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
        throw new Error("ExchangeRate-API returned no rates data");
      }

      logger.debug(
        {
          baseCurrencySymbol,
          tokenCount: tokens.length,
          url,
          apiResponseBase: data.base,
        },
        "Processing exchange rates in fetchExchangeRates"
      );

      // Process each token and find its rate
      for (const { token, providerTokenId } of tokens) {
        const symbol = (providerTokenId || token.symbol).toUpperCase();

        logger.debug(
          { tokenSymbol: symbol, tokenId: token.id, baseCurrencySymbol },
          "Processing token in fetchExchangeRates"
        );

        if (symbol === baseCurrencySymbol) {
          // Same currency = 1.0
          results.push({
            tokenId: token.id,
            price: "1.0",
            timestamp,
            source: PROVIDER_CONFIGS.exchangeRate.name,
          });
        } else if (data.rates[symbol]) {
          // Found exchange rate - but we need to invert it!
          // API returns rates FROM base currency TO other currencies
          // e.g., when baseCurrency=USD, data.rates.IDR = 16642 means 1 USD = 16642 IDR
          // But we want to convert FROM token currency TO base currency
          // So 1 IDR = 1/16642 USD
          const rateFromBaseToToken = new Decimal(data.rates[symbol]);
          const priceInBaseCurrency = new Decimal(1).div(rateFromBaseToToken);

          results.push({
            tokenId: token.id,
            price: priceInBaseCurrency.toString(),
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
              new Error("Currency rate not available"),
              response,
              false
            )
          );
        }
      }
    } catch (error) {
      logger.error(
        { error, provider: "exchangeRate" },
        "ExchangeRate-API fetch failed"
      );

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
            "ExchangeRate: Skipping non-cacheable error"
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
        .join(",");

      if (!coinIds) {
        throw new Error("No valid CoinGecko IDs found for tokens");
      }

      const baseCurrencyLower = baseCurrencySymbol.toLowerCase();
      let apiCurrency = baseCurrencyLower;
      let needsConversion = false;

      // First, try to get prices in the requested base currency
      let url = `${PROVIDER_CONFIGS.coinGecko.baseUrl}/simple/price?ids=${coinIds}&vs_currencies=${apiCurrency}`;

      logger.debug(
        { url, coinIds, baseCurrency: baseCurrencySymbol },
        "CoinGecko: Making rate-limited API request"
      );

      let response = await this.coinGeckoRateLimiter.execute(async () => {
        return await fetch(url);
      });

      if (!response.ok) {
        throw new Error(
          `CoinGecko API responded with ${response.status}: ${response.statusText}`
        );
      }

      let data = (await response.json()) as CoinGeckoPrice;

      logger.debug(
        { data, coinIds, responseKeys: Object.keys(data) },
        "CoinGecko: API response received"
      );

      // Check if any token has price data in the requested currency
      const hasDataInBaseCurrency = tokens.some(
        ({ providerTokenId, token }) => {
          const coinId = providerTokenId || token.symbol.toLowerCase();
          return data[coinId]?.[apiCurrency] !== undefined;
        }
      );

      // If no data in base currency and base currency is not USD, try USD
      if (!hasDataInBaseCurrency && baseCurrencyLower !== "usd") {
        logger.debug(
          { baseCurrency: baseCurrencySymbol },
          "CoinGecko: Base currency not supported, trying USD fallback"
        );

        apiCurrency = "usd";
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
          "CoinGecko: Processing token"
        );

        const priceValue = priceData?.[apiCurrency];
        if (priceValue !== undefined && priceValue !== null) {
          let finalPrice = priceValue.toString();

          // Convert price if needed
          if (needsConversion) {
            finalPrice = await this.convertPrice(
              finalPrice,
              "USD", // We fetched in USD
              baseCurrencySymbol.toUpperCase(),
              timestamp
            );

            if (finalPrice === "0") {
              // Conversion failed
              results.push({
                tokenId: token.id,
                price: "0",
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
              new Error("No price data available for token"),
              response,
              true // dataEmpty = true
            )
          );
        }
      }
    } catch (error) {
      logger.error(
        { error, provider: "coinGecko" },
        "CoinGecko API fetch failed"
      );

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
            "CoinGecko: Skipping non-cacheable error"
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
      const needsConversion = baseCurrencyUpper !== "USD";

      if (needsConversion) {
        logger.debug(
          { baseCurrency: baseCurrencySymbol },
          "Finnhub: Base currency not supported, will convert from USD"
        );
      }

      // Finnhub doesn't have a batch endpoint, so we make rate-limited individual requests
      const promises = tokens.map(async ({ token, providerTokenId }) => {
        try {
          const symbol = (providerTokenId || token.symbol).toUpperCase();

          const response = await this.finnhubRateLimiter.execute(async () => {
            const url = `${PROVIDER_CONFIGS.finnhub.baseUrl}/quote?symbol=${symbol}&token=${config.finnhub.apiKey}`;
            logger.debug(
              { symbol, url },
              "Finnhub: Making rate-limited API request"
            );
            return await fetch(url);
          });

          if (!response.ok) {
            // Handle API failures with response context
            return this.createFailureResult(
              token.id,
              timestamp,
              PROVIDER_CONFIGS.finnhub.name,
              new Error(
                `Finnhub API responded with ${response.status} for ${symbol}`
              ),
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
                "USD", // Finnhub provides USD prices
                baseCurrencyUpper,
                timestamp
              );

              if (finalPrice === "0") {
                // Conversion failed
                return {
                  tokenId: token.id,
                  price: "0",
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
              new Error("No valid price data from Finnhub"),
              response,
              false // not necessarily empty response
            );
          }
        } catch (error) {
          logger.error(
            { error, symbol: token.symbol, provider: "finnhub" },
            "Finnhub fetch failed for token"
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
              "Finnhub: Error not cacheable, but returning result anyway"
            );
            throw error; // This will be caught by Promise.all and may cause partial failures
          }
        }
      });

      // Wait for all requests to complete
      const fetchResults = await Promise.all(promises);
      results.push(...fetchResults);
    } catch (error) {
      logger.error(
        { error, provider: "finnhub" },
        "Finnhub API batch fetch failed"
      );

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
            "Finnhub: Skipping non-cacheable batch error"
          );
        }
      }
    }

    return results;
  }

  /**
   * Get exchange and currency information for a token
   * Checks token metadata first, then fetches from Finnhub if needed
   */
  private async getTokenExchangeInfo(
    token: Token
  ): Promise<CachedExchangeInfo | null> {
    // Check if exchange info is already stored in token metadata
    try {
      const metadata = JSON.parse(token.providerMetadata || "{}");
      if (metadata.exchangeInfo) {
        logger.debug(
          { tokenId: token.id, symbol: token.symbol },
          "Using cached exchange info from token metadata"
        );
        return metadata.exchangeInfo;
      }
    } catch (error) {
      logger.debug(
        { tokenId: token.id, error },
        "Failed to parse token metadata"
      );
    }

    // No cached exchange info, fetch from Finnhub using profile2 endpoint
    try {
      // Use Finnhub profile2 endpoint to get comprehensive company info including exchange
      const profileInfo = await this.fetchSymbolProfileFromFinnhub(
        token.symbol
      );

      if (profileInfo?.exchange) {
        const exchangeInfo: CachedExchangeInfo = {
          currency: profileInfo.currency || "USD", // Default to USD if not provided
          exchange: profileInfo.exchange,
          mic: profileInfo.exchange, // Use exchange as MIC fallback
        };

        // Store in token metadata for future use
        await this.updateTokenExchangeInfo(token.id, exchangeInfo);

        logger.debug(
          {
            tokenId: token.id,
            symbol: token.symbol,
            currency: exchangeInfo.currency,
            exchange: exchangeInfo.exchange,
            name: profileInfo.name,
            country: profileInfo.country,
          },
          "Found and cached exchange info for token using profile2"
        );

        return exchangeInfo;
      }

      logger.warn(
        { tokenId: token.id, symbol: token.symbol },
        "Symbol not found in Finnhub profile2 or no exchange info available"
      );

      // Fallback: Try to detect exchange info from symbol pattern
      const fallbackExchangeInfo = this.detectExchangeFromSymbol(token.symbol);
      if (fallbackExchangeInfo) {
        await this.updateTokenExchangeInfo(token.id, fallbackExchangeInfo);
        logger.debug(
          {
            tokenId: token.id,
            symbol: token.symbol,
            currency: fallbackExchangeInfo.currency,
            exchange: fallbackExchangeInfo.exchange,
            method: "symbol_pattern_detection",
          },
          "Detected exchange info from symbol pattern"
        );
        return fallbackExchangeInfo;
      }

      return null;
    } catch (error) {
      logger.error(
        { error, tokenId: token.id, symbol: token.symbol },
        "Error fetching exchange info from Finnhub"
      );
      return null;
    }
  }

  /**
   * Fetch comprehensive symbol profile from Finnhub including exchange information
   * Uses the /stock/profile2 endpoint which provides exchange, currency, and company details
   */
  private async fetchSymbolProfileFromFinnhub(
    symbol: string
  ): Promise<FinnhubProfileResponse | null> {
    try {
      const url = `${config.finnhub.baseUrl}/stock/profile2?symbol=${symbol}&token=${config.finnhub.apiKey}`;
      const response = await this.finnhubRateLimiter.execute(async () => {
        return await fetch(url);
      });

      if (!response.ok) {
        logger.debug(
          { symbol, status: response.status },
          "Failed to fetch symbol profile from Finnhub"
        );
        return null;
      }

      const profileData = (await response.json()) as FinnhubProfileResponse;

      // Validate that we got meaningful data (at least name and exchange)
      if (!profileData.name || !profileData.exchange) {
        logger.debug(
          { symbol, profileData },
          "Finnhub profile returned incomplete data"
        );
        return null;
      }

      logger.debug(
        {
          symbol,
          exchange: profileData.exchange,
          currency: profileData.currency,
          name: profileData.name,
          country: profileData.country,
        },
        "Successfully fetched symbol profile from Finnhub"
      );

      return profileData;
    } catch (error) {
      logger.debug(
        { error, symbol },
        "Error fetching symbol profile from Finnhub"
      );
      return null;
    }
  }

  /**
   * Detect exchange info from symbol pattern when Finnhub profile is unavailable
   * This is a fallback method for international stocks not covered by Finnhub free tier
   */
  private detectExchangeFromSymbol(symbol: string): CachedExchangeInfo | null {
    // Common exchange suffix patterns
    const exchangePatterns: Record<
      string,
      { exchange: string; currency: string; mic: string }
    > = {
      // European exchanges
      ".AS": { exchange: "AS", currency: "EUR", mic: "XAMS" }, // Amsterdam (Euronext Amsterdam)
      ".DE": { exchange: "DE", currency: "EUR", mic: "XETR" }, // Frankfurt (XETRA)
      ".PA": { exchange: "PA", currency: "EUR", mic: "XPAR" }, // Paris (Euronext Paris)
      ".MI": { exchange: "MI", currency: "EUR", mic: "MTAA" }, // Milan (Borsa Italiana)
      ".MC": { exchange: "MC", currency: "EUR", mic: "XMAD" }, // Madrid (BME)
      ".BR": { exchange: "BR", currency: "EUR", mic: "XBRU" }, // Brussels (Euronext Brussels)
      ".LS": { exchange: "LS", currency: "EUR", mic: "XLIS" }, // Lisbon (Euronext Lisbon)
      ".SW": { exchange: "SW", currency: "CHF", mic: "XSWX" }, // Switzerland (SIX Swiss Exchange)
      ".L": { exchange: "L", currency: "GBP", mic: "XLON" }, // London Stock Exchange

      // Nordic exchanges
      ".ST": { exchange: "ST", currency: "SEK", mic: "XSTO" }, // Stockholm (Nasdaq Stockholm)
      ".OL": { exchange: "OL", currency: "NOK", mic: "XOSL" }, // Oslo (Oslo Børs)
      ".CO": { exchange: "CO", currency: "DKK", mic: "XCSE" }, // Copenhagen (Nasdaq Copenhagen)
      ".HE": { exchange: "HE", currency: "EUR", mic: "XHEL" }, // Helsinki (Nasdaq Helsinki)
      ".IC": { exchange: "IC", currency: "ISK", mic: "XICE" }, // Iceland (Nasdaq Iceland)

      // North American exchanges
      ".TO": { exchange: "TO", currency: "CAD", mic: "XTSE" }, // Toronto Stock Exchange
      ".V": { exchange: "V", currency: "CAD", mic: "XTSX" }, // TSX Venture Exchange

      // Asian exchanges
      ".T": { exchange: "T", currency: "JPY", mic: "XJPX" }, // Tokyo Stock Exchange
      ".HK": { exchange: "HK", currency: "HKD", mic: "XHKG" }, // Hong Kong Stock Exchange
      ".SS": { exchange: "SS", currency: "CNY", mic: "XSHG" }, // Shanghai Stock Exchange
      ".SZ": { exchange: "SZ", currency: "CNY", mic: "XSHE" }, // Shenzhen Stock Exchange
      ".KS": { exchange: "KS", currency: "KRW", mic: "XKRX" }, // Korea Stock Exchange
      ".TW": { exchange: "TW", currency: "TWD", mic: "XTAI" }, // Taiwan Stock Exchange
      ".SI": { exchange: "SI", currency: "SGD", mic: "XSES" }, // Singapore Exchange
      ".AX": { exchange: "AX", currency: "AUD", mic: "XASX" }, // Australian Securities Exchange
      ".NZ": { exchange: "NZ", currency: "NZD", mic: "XNZE" }, // New Zealand Stock Exchange

      // Emerging markets
      ".SA": { exchange: "SA", currency: "BRL", mic: "BVMF" }, // Brazil (B3 - Brasil, Bolsa, Balcão)
      ".MX": { exchange: "MX", currency: "MXN", mic: "XMEX" }, // Mexico (Bolsa Mexicana de Valores)
      ".JO": { exchange: "JO", currency: "ZAR", mic: "XJSE" }, // Johannesburg Stock Exchange
      ".BO": { exchange: "BO", currency: "INR", mic: "XBOM" }, // Bombay Stock Exchange
      ".NS": { exchange: "NS", currency: "INR", mic: "XNSE" }, // National Stock Exchange of India
    };

    // Check for suffix patterns
    for (const [suffix, info] of Object.entries(exchangePatterns)) {
      if (symbol.toUpperCase().endsWith(suffix.toUpperCase())) {
        return {
          exchange: info.exchange,
          currency: info.currency,
          mic: info.mic,
        };
      }
    }

    // Special case for numeric Japanese stocks (like 7203.T)
    const japanesePattern = /^\d+\.T$/i;
    if (japanesePattern.test(symbol)) {
      return {
        exchange: "T",
        currency: "JPY",
        mic: "XJPX",
      };
    }

    // If no pattern matches, assume US stock (no suffix needed)
    // This handles stocks like AAPL, MSFT, etc.
    if (!symbol.includes(".") && !/[^A-Z0-9]/i.test(symbol)) {
      return {
        exchange: "US",
        currency: "USD",
        mic: "XNAS", // Default to NASDAQ
      };
    }

    // No pattern matched
    return null;
  }

  /**
   * Update token metadata with exchange information
   */
  private async updateTokenExchangeInfo(
    tokenId: string,
    exchangeInfo: CachedExchangeInfo
  ): Promise<void> {
    try {
      // Get current token metadata
      const [token] = await this.database
        .select({ providerMetadata: tokens.providerMetadata })
        .from(tokens)
        .where(eq(tokens.id, tokenId))
        .limit(1);

      if (!token) return;

      // Parse existing metadata
      let metadata: Record<string, unknown> = {};
      try {
        metadata =
          typeof token.providerMetadata === "string"
            ? JSON.parse(token.providerMetadata)
            : token.providerMetadata || {};
      } catch (error) {
        logger.warn(
          { tokenId, error },
          "Failed to parse existing token metadata"
        );
      }

      // Add exchange information
      metadata.exchangeInfo = {
        ...exchangeInfo,
        updatedAt: new Date().toISOString(),
      };

      // Update token metadata
      await this.database
        .update(tokens)
        .set({ providerMetadata: JSON.stringify(metadata) })
        .where(eq(tokens.id, tokenId));

      logger.debug(
        { tokenId, exchangeInfo },
        "Updated token metadata with exchange info"
      );
    } catch (error) {
      logger.error(
        { tokenId, exchangeInfo, error },
        "Failed to update token exchange info"
      );
    }
  }

  /**
   * Create appropriate GOOGLEFINANCE formula based on symbol and exchange info
   * Uses intelligent exchange prefix mapping and symbol formatting for Google Finance
   * Note: GOOGLEFINANCE returns prices in the native currency of the exchange
   * Currency conversion will be handled separately in our pricing logic
   *
   * IMPORTANT: Uses simple formulas without IFERROR to avoid locale issues
   * Relies on proper EXCHANGE:SYMBOL format as per GOOGLEFINANCE documentation
   */
  private createGoogleFinanceFormula(
    symbol: string,
    exchangeInfo: CachedExchangeInfo | null
  ): string {
    // GOOGLEFINANCE returns prices in the native currency of the exchange
    // We'll fetch the raw price and handle currency conversion in our backend logic
    // This ensures consistency with our other providers and proper conversion rates

    if (!exchangeInfo) {
      // No exchange info available, try the symbol as-is (likely US market)
      return `=GOOGLEFINANCE("${symbol}")`;
    }

    const googlePrefix = this.getGoogleFinancePrefix(exchangeInfo);
    const baseSymbol = this.extractBaseSymbol(symbol, exchangeInfo);

    if (googlePrefix) {
      // Use exchange prefix format: "EXCHANGE:SYMBOL" (recommended by GOOGLEFINANCE docs)
      const prefixedSymbol = `${googlePrefix}:${baseSymbol}`;
      return `=GOOGLEFINANCE("${prefixedSymbol}")`;
    } else {
      // No prefix needed (US markets) or fallback to base symbol
      return `=GOOGLEFINANCE("${baseSymbol}")`;
    }
  }

  /**
   * Extract base symbol from a ticker, removing exchange suffixes intelligently
   */
  private extractBaseSymbol(
    symbol: string,
    exchangeInfo: CachedExchangeInfo
  ): string {
    // If symbol doesn't contain dots, return as-is
    if (!symbol.includes(".")) {
      return symbol;
    }

    // Common exchange suffixes that should be removed for Google Finance
    const exchangeSuffixMap: Record<string, string[]> = {
      TSE: [".TO", ".TSX"], // Toronto
      LON: [".L", ".LSE"], // London
      FRA: [".DE", ".F", ".FRA"], // Frankfurt
      EPA: [".PA"], // Paris
      AMS: [".AS"], // Amsterdam
      ASX: [".AX"], // Australia
      TYO: [".T"], // Tokyo
      HKG: [".HK"], // Hong Kong
    };

    const googlePrefix = this.getGoogleFinancePrefix(exchangeInfo);

    if (googlePrefix && exchangeSuffixMap[googlePrefix]) {
      // Remove known exchange suffixes for this prefix
      for (const suffix of exchangeSuffixMap[googlePrefix]) {
        if (symbol.toUpperCase().endsWith(suffix)) {
          return symbol.substring(0, symbol.length - suffix.length);
        }
      }
    }

    // If no specific mapping found, remove everything after the last dot
    // This is a safe fallback for most international symbols
    return symbol.split(".")[0] || symbol;
  }

  /**
   * Get Google Finance exchange prefix from exchange information
   * Uses comprehensive mapping of exchange names to Google Finance prefixes
   * Supports international markets and various exchange naming conventions
   */
  private getGoogleFinancePrefix(
    exchangeInfo: CachedExchangeInfo
  ): string | null {
    const exchange = exchangeInfo.exchange.toUpperCase();

    // Comprehensive mapping of exchange names to Google Finance prefixes
    // Based on Finnhub exchange names and Google Finance supported markets
    const exchangeToPrefix: Record<string, string | null> = {
      // North American exchanges
      US: null, // US exchanges don't need prefix
      NASDAQ: null, // NASDAQ (US)
      NYSE: null, // New York Stock Exchange
      "NEW YORK STOCK EXCHANGE": null,
      "NASDAQ GLOBAL MARKET": null,
      "NASDAQ CAPITAL MARKET": null,

      // Canadian exchanges
      TO: "TSE", // Toronto (.TO suffix)
      TSX: "TSE", // Toronto Stock Exchange
      "TORONTO STOCK EXCHANGE": "TSE",
      "CANADIAN SECURITIES EXCHANGE": "CSE",
      "TSX VENTURE EXCHANGE": "CVE",

      // European exchanges
      L: "LON", // London (.L suffix)
      LSE: "LON", // London Stock Exchange
      "LONDON STOCK EXCHANGE": "LON",

      PA: "EPA", // Paris (.PA suffix)
      "EURONEXT PARIS": "EPA",
      PARIS: "EPA",

      DE: "FRA", // Frankfurt (.DE suffix)
      FRA: "FRA", // Frankfurt
      FRANKFURT: "FRA",
      XETRA: "FRA",
      "FRANKFURT STOCK EXCHANGE": "FRA",

      AS: "AMS", // Amsterdam (.AS suffix)
      "EURONEXT AMSTERDAM": "AMS",
      AMSTERDAM: "AMS",

      BR: "EBR", // Brussels (.BR suffix)
      "EURONEXT BRUSSELS": "EBR",
      BRUSSELS: "EBR",

      MI: "BIT", // Milan (.MI suffix)
      "BORSA ITALIANA": "BIT",
      MILAN: "BIT",

      MC: "BME", // Madrid (.MC suffix)
      MADRID: "BME",
      "BOLSA DE MADRID": "BME",

      LS: "ELI", // Lisbon (.LS suffix)
      "EURONEXT LISBON": "ELI",
      LISBON: "ELI",

      SW: "SWX", // Switzerland (.SW suffix)
      "SIX SWISS EXCHANGE": "SWX",
      SWISS: "SWX",
      ZURICH: "SWX",

      ST: "STO", // Stockholm (.ST suffix)
      "NASDAQ STOCKHOLM": "STO",
      STOCKHOLM: "STO",

      OL: "OSE", // Oslo (.OL suffix)
      "OSLO BORS": "OSE",
      OSLO: "OSE",

      CO: "CSE", // Copenhagen (.CO suffix)
      "NASDAQ COPENHAGEN": "CSE",
      COPENHAGEN: "CSE",

      HE: "HEL", // Helsinki (.HE suffix)
      "NASDAQ HELSINKI": "HEL",
      HELSINKI: "HEL",

      IC: "ICE", // Iceland (.IC suffix)
      "NASDAQ ICELAND": "ICE",
      ICELAND: "ICE",

      // Asia-Pacific exchanges
      T: null, // Tokyo (.T suffix) - no prefix needed for GOOGLEFINANCE
      "TOKYO STOCK EXCHANGE": null,
      TOKYO: null,

      HK: "HKG", // Hong Kong (.HK suffix)
      "HONG KONG STOCK EXCHANGE": "HKG",
      "HONG KONG": "HKG",

      SS: "SHA", // Shanghai (.SS suffix)
      "SHANGHAI STOCK EXCHANGE": "SHA",
      SHANGHAI: "SHA",

      SZ: "SHE", // Shenzhen (.SZ suffix)
      "SHENZHEN STOCK EXCHANGE": "SHE",
      SHENZHEN: "SHE",

      KS: "KRX", // South Korea (.KS suffix)
      "KOREA STOCK EXCHANGE": "KRX",
      SEOUL: "KRX",

      AX: "ASX", // Australia (.AX suffix)
      "AUSTRALIAN STOCK EXCHANGE": "ASX",
      AUSTRALIA: "ASX",

      NS: "NSE", // India NSE (.NS suffix)
      "NATIONAL STOCK EXCHANGE OF INDIA": "NSE",

      BO: "BSE", // India BSE (.BO suffix)
      "BOMBAY STOCK EXCHANGE": "BSE",

      SI: "SGX", // Singapore (.SI suffix)
      "SINGAPORE STOCK EXCHANGE": "SGX",
      SINGAPORE: "SGX",

      // Other markets
      TA: "TLV", // Tel Aviv (.TA suffix)
      "TEL AVIV STOCK EXCHANGE": "TLV",
      "TEL AVIV": "TLV",

      SA: "SAU", // Saudi Arabia (.SA suffix)
      "SAUDI STOCK EXCHANGE": "SAU",
      TADAWUL: "SAU",

      JO: "JSE", // Johannesburg (.JO suffix)
      "JOHANNESBURG STOCK EXCHANGE": "JSE",
      JOHANNESBURG: "JSE",

      MX: "BMV", // Mexico (.MX suffix)
      "BOLSA MEXICANA DE VALORES": "BMV",
      MEXICO: "BMV",

      BA: "BCBA", // Buenos Aires (.BA suffix)
      "BOLSA DE COMERCIO DE BUENOS AIRES": "BCBA",
      "BUENOS AIRES": "BCBA",
    };

    // Look up the prefix for this exchange
    const prefix = exchangeToPrefix[exchange];

    if (prefix !== undefined) {
      return prefix; // Could be null for US exchanges, which is correct
    }

    // If no exact match, try partial matching for complex exchange names
    const exchangeLower = exchange.toLowerCase();

    // Check for common patterns in exchange names
    if (exchangeLower.includes("nasdaq")) {
      return null; // Most NASDAQ markets don't need prefix for US
    }
    if (exchangeLower.includes("nyse") || exchangeLower.includes("new york")) {
      return null; // NYSE variations
    }
    if (exchangeLower.includes("toronto") || exchangeLower.includes("tsx")) {
      return "TSE";
    }
    if (exchangeLower.includes("london") || exchangeLower.includes("lse")) {
      return "LON";
    }
    if (
      exchangeLower.includes("frankfurt") ||
      exchangeLower.includes("xetra")
    ) {
      return "FRA";
    }
    if (exchangeLower.includes("paris") || exchangeLower.includes("euronext")) {
      return "EPA"; // Default Euronext to Paris
    }
    if (exchangeLower.includes("amsterdam")) {
      return "AMS";
    }
    if (exchangeLower.includes("tokyo")) {
      return "TYO";
    }
    if (exchangeLower.includes("hong kong")) {
      return "HKG";
    }
    if (exchangeLower.includes("australia") || exchangeLower.includes("asx")) {
      return "ASX";
    }

    // No matching exchange found
    logger.debug(
      { exchange: exchangeInfo.exchange },
      "No Google Finance prefix mapping found for exchange"
    );
    return null;
  }

  /**
   * Fetch prices from Google Sheets using GOOGLEFINANCE function
   * This serves as a fallback provider for tokens that aren't available in other APIs
   * Only works for live prices (within 1 hour window)
   */
  private async fetchGoogleSheetsPrices(
    tokensWithMetadata: TokenWithMetadata[],
    baseCurrencySymbol: string,
    timestamp: Date
  ): Promise<ProviderPriceResult[]> {
    const results: ProviderPriceResult[] = [];

    // Check if Google Sheets is available (validated on initialized)
    if (!this.googleSheetsAvailable || !this.googleSheetsCredentials) {
      logger.debug("Google Sheets not available, skipping fallback provider");
      return results;
    }

    // Only allow live prices (Google Sheets can't provide historical data)
    if (!this.isLivePrice(timestamp)) {
      logger.debug(
        "Google Sheets only supports live prices, timestamp too old"
      );
      return results;
    }

    logger.info(
      {
        tokenCount: tokensWithMetadata.length,
        baseCurrency: baseCurrencySymbol,
      },
      "Fetching prices from Google Sheets"
    );

    try {
      // Initialize Google Sheets API client using pre-validated credentials
      const auth = new google.auth.GoogleAuth({
        credentials: this.googleSheetsCredentials,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });

      const sheets = google.sheets({ version: "v4", auth });
      const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

      // Process each token using metadata to find existing sheet rows and group them
      const tokensWithExistingRows: {
        token: Token;
        rowNumber: number;
      }[] = [];
      const tokensToAdd: {
        token: Token;
        exchangeInfo: CachedExchangeInfo | null;
      }[] = [];

      // Group tokens by whether they already exist in the sheet
      for (const { token } of tokensWithMetadata) {
        // Check if token has Google Sheets row information in metadata
        // Refetch from DB to ensure we have the latest metadata (in case it was updated by a previous call)
        let existingRowNumber: number | null = null;
        let cachedExchangeInfo: CachedExchangeInfo | null = null;

        try {
          const [freshToken] = await db
            .select({ providerMetadata: tokens.providerMetadata })
            .from(tokens)
            .where(eq(tokens.id, token.id))
            .limit(1);

          const metadata = JSON.parse(freshToken?.providerMetadata || "{}");
          existingRowNumber = metadata.googleSheets?.rowNumber || null;
          cachedExchangeInfo = metadata.exchangeInfo || null;
        } catch {
          logger.debug(
            { tokenId: token.id },
            "No valid metadata found for token"
          );
        }

        if (existingRowNumber) {
          tokensWithExistingRows.push({ token, rowNumber: existingRowNumber });
        } else {
          tokensToAdd.push({ token, exchangeInfo: cachedExchangeInfo });
        }
      }

      // Read prices for existing tokens in parallel using batch API calls
      if (tokensWithExistingRows.length > 0) {
        logger.info(
          { existingTokenCount: tokensWithExistingRows.length },
          "Google Sheets: Reading prices for existing tokens in parallel"
        );

        // Use batch API to read multiple ranges at once (more efficient than individual calls)
        const ranges = tokensWithExistingRows.map(
          ({ rowNumber }) => `B${rowNumber}`
        );

        try {
          const batchResponse = await this.googleSheetsRateLimiter.execute(
            async () => {
              return await sheets.spreadsheets.values.batchGet({
                spreadsheetId,
                ranges,
              });
            }
          );

          const valueRanges = batchResponse.data.valueRanges || [];

          // Process results
          for (let i = 0; i < tokensWithExistingRows.length; i++) {
            const tokenRow = tokensWithExistingRows[i];
            if (!tokenRow) continue;

            const { token, rowNumber } = tokenRow;
            const priceValue = valueRanges[i]?.values?.[0]?.[0];

            if (isValidPrice(priceValue)) {
              const parsedPrice = parseInternationalNumber(priceValue);
              let price = parsedPrice!.toString();

              // Handle currency conversion if needed
              // Google Finance returns price in the native currency of the exchange
              try {
                const metadata = JSON.parse(token.providerMetadata || "{}");
                const exchangeInfo =
                  metadata.exchangeInfo as CachedExchangeInfo;

                if (
                  exchangeInfo?.currency &&
                  exchangeInfo.currency !== baseCurrencySymbol
                ) {
                  // Convert from native currency to requested base currency
                  price = await this.convertPrice(
                    price,
                    exchangeInfo.currency,
                    baseCurrencySymbol,
                    timestamp
                  );

                  if (price === "0") {
                    logger.warn(
                      {
                        symbol: token.symbol,
                        fromCurrency: exchangeInfo.currency,
                        toCurrency: baseCurrencySymbol,
                      },
                      "Google Sheets: Currency conversion failed"
                    );
                  } else {
                    logger.debug(
                      {
                        symbol: token.symbol,
                        originalPrice: priceValue,
                        convertedPrice: price,
                        fromCurrency: exchangeInfo.currency,
                        toCurrency: baseCurrencySymbol,
                      },
                      "Google Sheets: Price converted to base currency"
                    );
                  }
                }
              } catch (error) {
                logger.debug(
                  { symbol: token.symbol, error },
                  "Google Sheets: No currency conversion info available, using price as-is"
                );
              }

              results.push({
                tokenId: token.id,
                price,
                timestamp,
                source: PROVIDER_CONFIGS.googleSheets.name,
              });

              logger.debug(
                { symbol: token.symbol, price, row: rowNumber },
                "Google Sheets: Found existing price"
              );
            } else {
              logger.debug(
                { symbol: token.symbol, priceValue, row: rowNumber },
                "Google Sheets: Invalid price value"
              );
              results.push(
                this.createFailureResult(
                  token.id,
                  timestamp,
                  PROVIDER_CONFIGS.googleSheets.name,
                  new Error(`Invalid price value: ${priceValue}`),
                  undefined,
                  false
                )
              );
            }
          }
        } catch (error) {
          logger.error(
            { error, tokenCount: tokensWithExistingRows.length },
            "Google Sheets: Batch read failed, falling back to individual reads"
          );

          // Fallback to individual reads if batch fails
          const individualReadPromises = tokensWithExistingRows.map(
            async ({ token, rowNumber }) => {
              try {
                const priceResponse =
                  await this.googleSheetsRateLimiter.execute(async () => {
                    return await sheets.spreadsheets.values.get({
                      spreadsheetId,
                      range: `B${rowNumber}`,
                    });
                  });

                const priceValue = priceResponse.data.values?.[0]?.[0];

                if (isValidPrice(priceValue)) {
                  const parsedPrice = parseInternationalNumber(priceValue);
                  let price = parsedPrice!.toString();

                  // Handle currency conversion if needed
                  try {
                    const metadata = JSON.parse(token.providerMetadata || "{}");
                    const exchangeInfo =
                      metadata.exchangeInfo as CachedExchangeInfo;

                    if (
                      exchangeInfo?.currency &&
                      exchangeInfo.currency !== baseCurrencySymbol
                    ) {
                      price = await this.convertPrice(
                        price,
                        exchangeInfo.currency,
                        baseCurrencySymbol,
                        timestamp
                      );

                      if (price !== "0") {
                        logger.debug(
                          {
                            symbol: token.symbol,
                            originalPrice: priceValue,
                            convertedPrice: price,
                            fromCurrency: exchangeInfo.currency,
                            toCurrency: baseCurrencySymbol,
                          },
                          "Google Sheets: Individual read price converted"
                        );
                      }
                    }
                  } catch (error) {
                    logger.debug(
                      { symbol: token.symbol, error },
                      "Google Sheets: No currency conversion for individual read"
                    );
                  }

                  return {
                    tokenId: token.id,
                    price,
                    timestamp,
                    source: PROVIDER_CONFIGS.googleSheets.name,
                  };
                } else {
                  return this.createFailureResult(
                    token.id,
                    timestamp,
                    PROVIDER_CONFIGS.googleSheets.name,
                    new Error(`Invalid price value: ${priceValue}`),
                    undefined,
                    false
                  );
                }
              } catch (error) {
                logger.warn(
                  { symbol: token.symbol, error, row: rowNumber },
                  "Google Sheets: Failed to read price from existing row"
                );
                return this.createFailureResult(
                  token.id,
                  timestamp,
                  PROVIDER_CONFIGS.googleSheets.name,
                  error,
                  undefined,
                  false
                );
              }
            }
          );

          // Wait for all individual reads to complete
          const individualResults = await Promise.all(individualReadPromises);
          results.push(...individualResults);
        }
      }

      // Add new tokens to the sheet
      if (tokensToAdd.length > 0) {
        // Count how many tokens need exchange info fetching vs cached
        const tokensNeedingExchangeInfo = tokensToAdd.filter(
          (t) => !t.exchangeInfo
        ).length;
        const tokensWithCachedInfo =
          tokensToAdd.length - tokensNeedingExchangeInfo;

        logger.info(
          {
            newTokenCount: tokensToAdd.length,
            needExchangeInfo: tokensNeedingExchangeInfo,
            haveCachedInfo: tokensWithCachedInfo,
          },
          "Processing new tokens for Google Sheets - optimized exchange info fetching"
        );

        // Fetch exchange info in parallel for tokens that don't have it cached
        const exchangeInfoPromises = tokensToAdd.map(async (tokenData) => {
          if (!tokenData.exchangeInfo) {
            // Fetch exchange info in parallel
            tokenData.exchangeInfo = await this.getTokenExchangeInfo(
              tokenData.token
            );
          } else {
            logger.debug(
              { tokenId: tokenData.token.id, symbol: tokenData.token.symbol },
              "Using cached exchange info for new Google Sheets token"
            );
          }
          return tokenData;
        });

        // Wait for all exchange info fetching to complete
        await Promise.all(exchangeInfoPromises);

        // Declare variables outside the lock block so they can be used afterwards
        let nextRow: number = 1; // Initialize to avoid TS error, will be set properly in lock
        const newRows: string[][] = [];

        // CRITICAL SECTION: Use PostgreSQL advisory lock to prevent row assignment conflicts
        // across multiple API instances
        await this.withGoogleSheetsLock(async () => {
          // Get current sheet size to know where to append (with rate limiting)
          const sheetInfoResponse = await this.googleSheetsRateLimiter.execute(
            async () => {
              return await sheets.spreadsheets.values.get({
                spreadsheetId,
                range: "A:A",
              });
            }
          );
          const currentRows = sheetInfoResponse.data.values || [];
          nextRow = currentRows.length + 1;

          logger.info(
            {
              currentSheetRows: currentRows.length,
              nextRowToUse: nextRow,
              tokensToAdd: tokensToAdd.length,
            },
            "Google Sheets: Assigning row numbers with advisory lock protection"
          );

          for (let index = 0; index < tokensToAdd.length; index++) {
            const tokenToAdd = tokensToAdd[index];
            if (!tokenToAdd) continue;

            const { token, exchangeInfo } = tokenToAdd;
            const symbol = token.symbol.toUpperCase();
            const rowNumber = nextRow + index;

            // Create GOOGLEFINANCE formula based on exchange information
            const formula = this.createGoogleFinanceFormula(
              symbol,
              exchangeInfo
            );

            newRows.push([symbol, formula, new Date().toISOString()]); // Symbol, Formula, Timestamp

            // Store row number and exchange info in token metadata for future reference (sync to prevent duplicates)
            await this.updateTokenGoogleSheetsMetadata(
              token.id,
              rowNumber,
              exchangeInfo
            );

            logger.debug(
              {
                tokenId: token.id,
                symbol,
                assignedRow: rowNumber,
              },
              "Google Sheets: Assigned row number to token"
            );
          }

          // Append new rows with rate limiting
          await this.googleSheetsRateLimiter.execute(async () => {
            return await sheets.spreadsheets.values.append({
              spreadsheetId,
              range: "A:C", // Symbol (A), Price/Formula (B), Timestamp (C)
              valueInputOption: "USER_ENTERED", // This will execute the GOOGLEFINANCE formulas
              requestBody: {
                values: newRows,
              },
            });
          });

          logger.info(
            {
              count: newRows.length,
              startingRow: nextRow,
              endingRow: nextRow + newRows.length - 1,
            },
            "Google Sheets: Added new tokens with row assignment protection"
          );
        });

        logger.info(
          { count: newRows.length },
          "Google Sheets: Added new tokens"
        );

        // Wait a moment for formulas to calculate, then read the prices
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Read the newly added prices using batch API for efficiency
        const newTokenRanges = tokensToAdd.map(
          (_, index) => `B${nextRow + index}`
        );

        try {
          const batchReadResponse = await this.googleSheetsRateLimiter.execute(
            async () => {
              return await sheets.spreadsheets.values.batchGet({
                spreadsheetId,
                ranges: newTokenRanges,
              });
            }
          );

          const valueRanges = batchReadResponse.data.valueRanges || [];

          // Process batch results
          for (let index = 0; index < tokensToAdd.length; index++) {
            const tokenData = tokensToAdd[index];
            if (!tokenData) continue;

            const { token, exchangeInfo } = tokenData;
            const rowNumber = nextRow + index;
            const priceValue = valueRanges[index]?.values?.[0]?.[0];

            if (isValidPrice(priceValue)) {
              const parsedPrice = parseInternationalNumber(priceValue);
              let price = parsedPrice!.toString();

              // Handle currency conversion if needed
              // We have fresh exchange info for new tokens
              if (
                exchangeInfo?.currency &&
                exchangeInfo.currency !== baseCurrencySymbol
              ) {
                const originalPrice = price;
                price = await this.convertPrice(
                  price,
                  exchangeInfo.currency,
                  baseCurrencySymbol,
                  timestamp
                );

                if (price === "0") {
                  logger.warn(
                    {
                      symbol: token.symbol,
                      fromCurrency: exchangeInfo.currency,
                      toCurrency: baseCurrencySymbol,
                    },
                    "Google Sheets: Currency conversion failed for new token"
                  );
                } else {
                  logger.debug(
                    {
                      symbol: token.symbol,
                      originalPrice,
                      convertedPrice: price,
                      fromCurrency: exchangeInfo.currency,
                      toCurrency: baseCurrencySymbol,
                    },
                    "Google Sheets: New token price converted to base currency"
                  );
                }
              }

              results.push({
                tokenId: token.id,
                price,
                timestamp,
                source: PROVIDER_CONFIGS.googleSheets.name,
              });

              logger.debug(
                { symbol: token.symbol, price, row: rowNumber },
                "Google Sheets: Got price for new token"
              );
            } else {
              logger.debug(
                { symbol: token.symbol, priceValue, row: rowNumber },
                "Google Sheets: No valid price for new token"
              );
              results.push(
                this.createFailureResult(
                  token.id,
                  timestamp,
                  PROVIDER_CONFIGS.googleSheets.name,
                  new Error(`No valid price returned: ${priceValue}`),
                  undefined,
                  false
                )
              );
            }
          }
        } catch (error) {
          logger.error(
            { error, tokenCount: tokensToAdd.length },
            "Google Sheets: Batch read of new tokens failed, falling back to individual reads"
          );

          // Fallback to individual reads if batch fails
          const individualReadPromises = tokensToAdd.map(
            async ({ token, exchangeInfo }, index) => {
              const rowNumber = nextRow + index;

              try {
                const priceResponse =
                  await this.googleSheetsRateLimiter.execute(async () => {
                    return await sheets.spreadsheets.values.get({
                      spreadsheetId,
                      range: `B${rowNumber}`,
                    });
                  });

                const priceValue = priceResponse.data.values?.[0]?.[0];

                if (isValidPrice(priceValue)) {
                  const parsedPrice = parseInternationalNumber(priceValue);
                  let price = parsedPrice!.toString();

                  // Handle currency conversion if needed
                  if (
                    exchangeInfo?.currency &&
                    exchangeInfo.currency !== baseCurrencySymbol
                  ) {
                    const originalPrice = price;
                    price = await this.convertPrice(
                      price,
                      exchangeInfo.currency,
                      baseCurrencySymbol,
                      timestamp
                    );

                    if (price !== "0") {
                      logger.debug(
                        {
                          symbol: token.symbol,
                          originalPrice,
                          convertedPrice: price,
                          fromCurrency: exchangeInfo.currency,
                          toCurrency: baseCurrencySymbol,
                        },
                        "Google Sheets: New token individual read price converted"
                      );
                    }
                  }

                  return {
                    tokenId: token.id,
                    price,
                    timestamp,
                    source: PROVIDER_CONFIGS.googleSheets.name,
                  };
                } else {
                  return this.createFailureResult(
                    token.id,
                    timestamp,
                    PROVIDER_CONFIGS.googleSheets.name,
                    new Error(`No valid price returned: ${priceValue}`),
                    undefined,
                    false
                  );
                }
              } catch (error) {
                logger.warn(
                  { symbol: token.symbol, error, row: rowNumber },
                  "Google Sheets: Failed to read new token price"
                );
                return this.createFailureResult(
                  token.id,
                  timestamp,
                  PROVIDER_CONFIGS.googleSheets.name,
                  error,
                  undefined,
                  false
                );
              }
            }
          );

          // Wait for all individual reads to complete
          const individualResults = await Promise.all(individualReadPromises);
          results.push(...individualResults);
        }
      }
    } catch (error) {
      logger.error(
        { error, provider: "googleSheets" },
        "Google Sheets API failed"
      );

      // Create failure results for all tokens
      for (const tokenData of tokensWithMetadata) {
        const token = tokenData.token;
        try {
          results.push(
            this.createFailureResult(
              token.id,
              timestamp,
              PROVIDER_CONFIGS.googleSheets.name,
              error,
              undefined,
              false
            )
          );
        } catch (nonCacheableError) {
          logger.debug(
            { error: nonCacheableError, tokenId: token.id },
            "Google Sheets: Skipping non-cacheable error"
          );
        }
      }
    }

    return results;
  }

  /**
   * Update token metadata with Google Sheets row information and exchange info
   */
  private async updateTokenGoogleSheetsMetadata(
    tokenId: string,
    rowNumber: number,
    exchangeInfo: CachedExchangeInfo | null = null
  ): Promise<void> {
    try {
      // Get current token metadata
      const [token] = await db
        .select({ providerMetadata: tokens.providerMetadata })
        .from(tokens)
        .where(eq(tokens.id, tokenId))
        .limit(1);

      if (!token) return;

      // Parse existing metadata
      let metadata: Record<string, unknown> = {};
      try {
        metadata =
          typeof token.providerMetadata === "string"
            ? JSON.parse(token.providerMetadata)
            : token.providerMetadata || {};
      } catch (error) {
        logger.warn(
          { tokenId, error },
          "Failed to parse existing token metadata"
        );
      }

      // Add Google Sheets information with both row and column
      metadata.googleSheets = {
        rowNumber,
        column: "B", // Price/Formula column is always B
        addedAt: new Date().toISOString(),
      };

      // Store exchange info if provided (for new tokens being added to sheet)
      if (exchangeInfo && !metadata.exchangeInfo) {
        metadata.exchangeInfo = {
          ...exchangeInfo,
          updatedAt: new Date().toISOString(),
        };
      }

      // Update token metadata
      await db
        .update(tokens)
        .set({ providerMetadata: JSON.stringify(metadata) })
        .where(eq(tokens.id, tokenId));

      logger.debug(
        { tokenId, rowNumber, column: "B", hasExchangeInfo: !!exchangeInfo },
        "Updated token metadata with Google Sheets row, column and exchange info"
      );
    } catch (error) {
      logger.error(
        { tokenId, rowNumber, error },
        "Failed to update token Google Sheets metadata"
      );
    }
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
    const exchangeRateTokens = tokensByProvider.get("exchangeRate");
    if (exchangeRateTokens && exchangeRateTokens.length > 0) {
      providerPromises.push(
        this.fetchExchangeRates(
          exchangeRateTokens,
          baseCurrencyToken.symbol,
          timestamp
        )
      );
    }

    // CoinGecko for cryptocurrencies
    const coinGeckoTokens = tokensByProvider.get("coinGecko");
    if (coinGeckoTokens && coinGeckoTokens.length > 0) {
      providerPromises.push(
        this.fetchCoinGeckoPrices(
          coinGeckoTokens,
          baseCurrencyToken.symbol,
          timestamp
        )
      );
    }

    // Finnhub for stocks/ETFs
    const finnhubTokens = tokensByProvider.get("finnhub");
    if (finnhubTokens && finnhubTokens.length > 0) {
      providerPromises.push(
        this.fetchFinnhubPrices(
          finnhubTokens,
          baseCurrencyToken.symbol,
          timestamp
        )
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
      logger.error({ error }, "One or more provider calls failed");
      // Individual provider methods already handle their own errors,
      // so this should rarely happen, but we log it just in case
    }

    // Check for tokens that still need prices and try Google Sheets as fallback
    const allTokens = Array.from(tokensByProvider.values()).flat();
    const tokensStillNeedingPrices = allTokens.filter(
      (token) =>
        !allResults.some(
          (result) => result.tokenId === token.token.id && result.price !== "0"
        )
    );

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
        tokensNeedingPrices: tokensStillNeedingPrices.map((t) => ({
          tokenId: t.token.id,
          symbol: t.token.symbol,
        })),
      },
      "Checking tokens for Google Sheets fallback"
    );

    if (tokensStillNeedingPrices.length > 0 && this.googleSheetsAvailable) {
      // Filter to include Finnhub tokens AND tokens with Finnhub metadata for Google Sheets fallback
      const candidateTokens = tokensStillNeedingPrices.map((t) => t.token);
      const finnhubTokensForGoogleSheets =
        await this.filterTokensForGoogleSheets(candidateTokens);

      if (finnhubTokensForGoogleSheets.length > 0) {
        logger.info(
          {
            tokenCount: finnhubTokensForGoogleSheets.length,
            totalNeedingPrices: tokensStillNeedingPrices.length,
            tokensForGoogleSheets: finnhubTokensForGoogleSheets.map((t) => ({
              id: t.id,
              symbol: t.symbol,
            })),
          },
          "Trying Google Sheets fallback for Finnhub tokens without prices"
        );

        try {
          const googleSheetsTokens = finnhubTokensForGoogleSheets.map(
            (token) => ({
              token,
              provider: "googleSheets" as const,
            })
          );

          const googleSheetsPrices = await this.fetchGoogleSheetsPrices(
            googleSheetsTokens,
            baseCurrencyToken.symbol,
            timestamp
          );

          logger.info(
            {
              inputTokenCount: googleSheetsTokens.length,
              outputPriceCount: googleSheetsPrices.length,
              prices: googleSheetsPrices.map((p) => ({
                tokenId: p.tokenId,
                price: p.price,
                source: p.source,
              })),
            },
            "Google Sheets price fetch completed"
          );

          // Add Google Sheets prices to results
          for (const priceResult of googleSheetsPrices) {
            if (priceResult.price !== "0") {
              // Only use if we got a real price
              // Remove any existing failed result for this token
              const existingFailureIndex = allResults.findIndex(
                (result) =>
                  result.tokenId === priceResult.tokenId && result.price === "0"
              );
              if (existingFailureIndex !== -1) {
                allResults.splice(existingFailureIndex, 1);
              }
              allResults.push(priceResult);
            }
          }
        } catch (error) {
          logger.warn({ error }, "Google Sheets fallback failed");
        }
      } else {
        logger.debug(
          { totalTokens: tokensStillNeedingPrices.length },
          "No Finnhub tokens found for Google Sheets fallback"
        );
      }
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
      await this.database.insert(tokenPrices).values(priceRecords);
      logger.debug(
        { cachedCount: priceRecords.length },
        "Successfully cached price results to database"
      );
    } catch (error) {
      logger.error({ error, priceRecords }, "Failed to cache price results");
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

    // Don't cache rate limiting (429) or server errors (5xx)
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

    // Handle API tier limitations - 403 Forbidden typically means access denied due to plan restrictions
    if (response && response.status === 403) {
      return {
        shouldCache: true,
        cacheWindow: this.UNAVAILABLE_CACHE_MS,
        sourcePrefix: "tier_limitation",
        isTierLimitation: true,
      };
    }

    // Handle 401 Unauthorized - could be API key issue or tier limitation
    if (response && response.status === 401) {
      return {
        shouldCache: true,
        cacheWindow: this.UNAVAILABLE_CACHE_MS,
        sourcePrefix: "unauthorized_access",
        isTierLimitation: true,
      };
    }

    // Don't cache empty responses (likely wrong token ID)
    if (dataEmpty === true && response?.ok) {
      return {
        shouldCache: true,
        cacheWindow: this.RETRYABLE_FAILURE_CACHE_MS,
        sourcePrefix: "empty_response",
      };
    }

    // Cache client errors (4xx) as truly unavailable, but check if it might be tier-related
    if (response && response.status >= 400 && response.status < 500) {
      // 404 might be token not found, but could also be tier limitation for some providers
      const isTierIssue =
        response.status === 404 && this.isPotentialTierLimitation(error);
      return {
        shouldCache: true,
        cacheWindow: this.UNAVAILABLE_CACHE_MS,
        sourcePrefix: isTierIssue ? "tier_limitation" : "unavailable",
        isTierLimitation: isTierIssue,
      };
    }

    // Default: cache with short window for unknown failures
    return {
      shouldCache: true,
      cacheWindow: this.RETRYABLE_FAILURE_CACHE_MS,
      sourcePrefix: "unknown_error",
    };
  }

  /**
   * Check if an error might be due to tier limitations based on error message
   */
  private isPotentialTierLimitation(error: Error | unknown): boolean {
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

  /**
   * Check if a token has Finnhub metadata in its providerMetadata
   */
  private tokenHasFinnhubMetadata(token: Token): boolean {
    try {
      const metadata = JSON.parse(token.providerMetadata || "{}");
      return !!metadata.finnhub?.symbol;
    } catch {
      return false;
    }
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
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `${providerName} ${cacheStrategy.sourcePrefix}: ${errorMessage}`
      );
    }

    // Update token metadata if this is a tier limitation (async, don't wait)
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

      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Parse existing metadata or create new
      let currentMetadata = {};
      if (token.providerMetadata) {
        try {
          currentMetadata =
            typeof token.providerMetadata === "string"
              ? JSON.parse(token.providerMetadata)
              : token.providerMetadata;
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

// ================================================================
// SINGLETON INSTANCE
// ================================================================

export const pricingService = new PricingService();
