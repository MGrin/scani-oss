import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { config } from '../config/pricing';
import { db } from '../db/connection';
import type { NewTokenPrice, Token } from '../db/schema';
import { tokenPrices, tokens, tokenTypes } from '../db/schema';

export interface PriceRequest {
  tokenSymbol: string;
  baseCurrency: string; // Symbol of base currency (USD, EUR, etc.)
  timestamp: Date;
  live?: boolean; // If true, get current price; if false, get historical
}

export interface PriceResult {
  tokenSymbol: string;
  baseCurrency: string;
  price: string; // Changed to string for Decimal.js precision
  timestamp: Date;
  source: string;
}

export class PricingService {
  constructor(private readonly database = db) {}

  /**
   * Get token price in base currency at specific timestamp
   * First checks cache, then fetches from appropriate provider
   * Returns "0" if price is unavailable (without caching the 0)
   */
  async getTokenPrice(request: PriceRequest): Promise<string> {
    const { tokenSymbol, baseCurrency, timestamp, live = false } = request;

    // First, try to get from cache
    const cachedPrice = await this.getCachedPrice(tokenSymbol, baseCurrency, timestamp, live);
    if (cachedPrice) {
      return cachedPrice.price;
    }

    // If no cached price found, always try to fetch from provider
    // The 1-hour cache limitation is still enforced in getCachedPrice

    // Get token info to determine provider
    const token = await this.getTokenBySymbol(tokenSymbol);
    if (!token) {
      console.warn(`Token ${tokenSymbol} not found, using price 0`);
      return '0';
    }

    // If token and base currency are the same, return 1
    if (tokenSymbol.toUpperCase() === baseCurrency.toUpperCase()) {
      return '1';
    }

    try {
      // Fetch from appropriate provider based on token type
      const result = await this.fetchPriceFromProvider(token, baseCurrency, timestamp, live);

      // Only cache non-zero prices
      if (result.price !== '0' && parseFloat(result.price) > 0) {
        await this.cachePrice(
          token.id,
          baseCurrency,
          result.price,
          result.timestamp,
          result.source
        );
      }

      return result.price;
    } catch (error) {
      console.warn(
        `Failed to fetch price for ${tokenSymbol}/${baseCurrency}: ${error}. Using price 0.`
      );
      return '0';
    }
  }

  /**
   * Get multiple token prices at once (more efficient)
   * Returns "0" for tokens where price cannot be fetched
   */
  async getTokenPrices(requests: PriceRequest[]): Promise<Record<string, string>> {
    const results: Record<string, string> = {};

    // For now, process sequentially. In production, you'd batch by provider
    for (const request of requests) {
      const price = await this.getTokenPrice(request);
      results[request.tokenSymbol] = price;
    }

    return results;
  }

  private async getCachedPrice(
    tokenSymbol: string,
    baseCurrency: string,
    timestamp: Date,
    requireFresh: boolean = true
  ): Promise<{ price: string } | null> {
    const token = await this.getTokenBySymbol(tokenSymbol);
    const baseCurrencyToken = await this.getTokenBySymbol(baseCurrency);

    if (!token || !baseCurrencyToken) return null;

    if (requireFresh) {
      // Look for price within time window for fresh prices
      const isLive = this.isLivePrice(timestamp);
      const timeWindow = isLive ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000; // 1 hour or 1 day

      const startTime = new Date(timestamp.getTime() - timeWindow);
      const endTime = new Date(timestamp.getTime() + timeWindow);

      const result = await this.database
        .select()
        .from(tokenPrices)
        .where(
          and(
            eq(tokenPrices.tokenId, token.id),
            eq(tokenPrices.baseTokenId, baseCurrencyToken.id),
            gte(tokenPrices.timestamp, startTime),
            lte(tokenPrices.timestamp, endTime)
          )
        )
        .orderBy(desc(tokenPrices.timestamp))
        .limit(1);

      return result[0] ? { price: result[0].price } : null;
    } else {
      // Get the latest available cached price regardless of age
      const result = await this.database
        .select()
        .from(tokenPrices)
        .where(
          and(eq(tokenPrices.tokenId, token.id), eq(tokenPrices.baseTokenId, baseCurrencyToken.id))
        )
        .orderBy(desc(tokenPrices.timestamp))
        .limit(1);

      return result[0] ? { price: result[0].price } : null;
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

  private isLivePrice(timestamp: Date): boolean {
    const now = new Date();
    const diffHours = (now.getTime() - timestamp.getTime()) / (1000 * 60 * 60);
    return diffHours < 2; // Consider anything within 2 hours as "live"
  }

  private async fetchPriceFromProvider(
    token: Token,
    baseCurrency: string,
    timestamp: Date,
    live: boolean
  ): Promise<PriceResult> {
    // Get token type to determine provider
    const tokenType = await this.getTokenType(token.typeId);

    let result: PriceResult;

    switch (tokenType?.code) {
      case 'crypto':
        result = await this.fetchCryptoPrice(token.symbol, baseCurrency, timestamp, live);
        break;
      case 'stock':
      case 'etf':
      case 'bond':
      case 'commodity':
      case 'mutual-fund':
        result = await this.fetchStockPrice(token.symbol, baseCurrency, timestamp, live);
        break;
      case 'fiat':
        result = await this.fetchForexPrice(token.symbol, baseCurrency, timestamp, live);
        break;
      case 'private-company':
      case 'other':
        result = await this.fetchManualPrice(token, baseCurrency, timestamp);
        break;
      default:
        throw new Error(`Unsupported token type: ${tokenType?.code}`);
    }

    // Check if we need multi-step conversion
    // For example: XEQT priced in CAD but base currency is EUR -> CAD to EUR
    // Or: BTC priced in USD but base currency is GEL -> USD to GEL
    if (result.baseCurrency !== baseCurrency) {
      const conversionRate = await this.getConversionRate(
        result.baseCurrency,
        baseCurrency,
        timestamp,
        live
      );

      const convertedPrice = (parseFloat(result.price) * conversionRate).toString();

      return {
        ...result,
        baseCurrency: baseCurrency,
        price: convertedPrice,
        source: `${result.source}_converted_via_${result.baseCurrency}`,
      };
    }

    return result;
  }

  private async getTokenType(typeId: string) {
    const result = await this.database
      .select()
      .from(tokenTypes)
      .where(eq(tokenTypes.id, typeId))
      .limit(1);
    return result[0] || null;
  }

  /**
   * Get CoinGecko ID from token's provider metadata
   * If not found, attempts to discover and store it
   */
  private async getCoinGeckoId(symbol: string): Promise<string> {
    // First try to get from database
    const token = await this.getTokenBySymbol(symbol);
    if (token?.providerMetadata) {
      try {
        const metadata = JSON.parse(token.providerMetadata);
        if (metadata.coingecko?.id) {
          return metadata.coingecko.id;
        }
      } catch {
        // Invalid JSON, continue to discovery
      }
    }

    // If not found, try to discover the CoinGecko ID
    const discoveredId = await this.discoverCoinGeckoId(symbol);

    // Store it in the database for future use
    if (token && discoveredId) {
      await this.updateTokenProviderMetadata(token.id, 'coingecko', {
        id: discoveredId,
      });
    }

    return discoveredId || symbol.toLowerCase(); // Fallback to lowercase symbol
  }

  /**
   * Discover CoinGecko ID by searching their API
   */
  private async discoverCoinGeckoId(symbol: string): Promise<string | null> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (config.coinGecko.apiKey) {
        headers['x-cg-pro-api-key'] = config.coinGecko.apiKey;
      }

      // Search CoinGecko for the symbol
      const searchUrl = `${config.coinGecko.baseUrl}/search?query=${symbol}`;
      const response = await fetch(searchUrl, { headers });

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as {
        coins: Array<{ id: string; symbol: string; name: string }>;
      };

      // Find exact symbol match
      const match = data.coins.find((coin) => coin.symbol.toLowerCase() === symbol.toLowerCase());

      return match?.id || null;
    } catch (error) {
      console.warn(`Failed to discover CoinGecko ID for ${symbol}:`, error);
      return null;
    }
  }

  /**
   * Update token's provider metadata in database
   */
  private async updateTokenProviderMetadata(
    tokenId: string,
    provider: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    try {
      const token = await this.database
        .select()
        .from(tokens)
        .where(eq(tokens.id, tokenId))
        .limit(1);

      if (!token[0]) return;

      let currentMetadata = {};
      try {
        currentMetadata = JSON.parse(token[0].providerMetadata || '{}');
      } catch {
        // Invalid JSON, start fresh
      }

      const updatedMetadata = {
        ...currentMetadata,
        [provider]: metadata,
      };

      await this.database
        .update(tokens)
        .set({
          providerMetadata: JSON.stringify(updatedMetadata),
          updatedAt: new Date(),
        })
        .where(eq(tokens.id, tokenId));
    } catch (error) {
      console.warn(`Failed to update provider metadata for token ${tokenId}:`, error);
    }
  }

  // Crypto pricing using CoinGecko (free tier friendly)
  private async fetchCryptoPrice(
    symbol: string,
    baseCurrency: string,
    timestamp: Date,
    live: boolean
  ): Promise<PriceResult> {
    const baseUrl = config.coinGecko.baseUrl;

    // Get CoinGecko ID from token's provider metadata
    const coinId = await this.getCoinGeckoId(symbol);

    // Prepare headers with API key if available
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (config.coinGecko.apiKey) {
      headers['x-cg-pro-api-key'] = config.coinGecko.apiKey;
    }

    if (live) {
      // Try requested currency first, fallback to USD if not supported
      let actualCurrency = baseCurrency;
      let url = `${baseUrl}/simple/price?ids=${coinId}&vs_currencies=${baseCurrency.toLowerCase()}`;
      let response = await fetch(url, { headers });

      if (!response.ok) {
        throw new Error(`CoinGecko API error: ${response.status} ${response.statusText}`);
      }

      let data = (await response.json()) as Record<string, Record<string, number>>;
      let price = data[coinId]?.[baseCurrency.toLowerCase()];

      // If price not found for requested currency, try USD
      if (!price && baseCurrency.toUpperCase() !== 'USD') {
        actualCurrency = 'USD';
        url = `${baseUrl}/simple/price?ids=${coinId}&vs_currencies=usd`;
        response = await fetch(url, { headers });

        if (!response.ok) {
          throw new Error(`CoinGecko API error: ${response.status} ${response.statusText}`);
        }

        data = (await response.json()) as Record<string, Record<string, number>>;
        price = data[coinId]?.usd;
      }

      if (!price) {
        console.warn(`Price not found for ${symbol} in any supported currency, using 0`);
        return {
          tokenSymbol: symbol,
          baseCurrency: actualCurrency,
          price: '0',
          timestamp: new Date(),
          source: 'coingecko_current_unavailable',
        };
      }

      return {
        tokenSymbol: symbol,
        baseCurrency: actualCurrency,
        price: price.toString(),
        timestamp: new Date(),
        source: 'coingecko_current',
      };
    } else {
      // Historical price using coin ID
      const dateString = timestamp.toISOString().split('T')[0]; // YYYY-MM-DD
      const url = `${baseUrl}/coins/${coinId}/history?date=${dateString}`;

      const response = await fetch(url, { headers });

      if (!response.ok) {
        throw new Error(`CoinGecko API error: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as {
        market_data?: { current_price?: Record<string, number> };
      };

      // Try requested currency first, fallback to USD
      let actualCurrency = baseCurrency;
      let price = data.market_data?.current_price?.[baseCurrency.toLowerCase()];

      if (!price && baseCurrency.toUpperCase() !== 'USD') {
        actualCurrency = 'USD';
        price = data.market_data?.current_price?.usd;
      }

      if (!price) {
        console.warn(
          `Historical price not found for ${symbol} on ${dateString} in any supported currency, using 0`
        );
        return {
          tokenSymbol: symbol,
          baseCurrency: actualCurrency,
          price: '0',
          timestamp,
          source: 'coingecko_historical_unavailable',
        };
      }

      return {
        tokenSymbol: symbol,
        baseCurrency: actualCurrency,
        price: price.toString(),
        timestamp,
        source: 'coingecko_historical',
      };
    }
  }

  // Stock/ETF/Bond/Commodity pricing using Finnhub
  private async fetchStockPrice(
    symbol: string,
    _baseCurrency: string,
    timestamp: Date,
    live: boolean
  ): Promise<PriceResult> {
    const apiKey = config.finnhub.apiKey;

    if (!apiKey) {
      throw new Error('Finnhub API key not configured');
    }

    if (live) {
      // Get company profile to determine the native currency
      const profileUrl = `${config.finnhub.baseUrl}/stock/profile2?symbol=${symbol}&token=${apiKey}`;
      const profileResponse = await fetch(profileUrl);

      let nativeCurrency = 'USD'; // Default fallback
      if (profileResponse.ok) {
        const profileData = (await profileResponse.json()) as {
          currency?: string;
        };
        nativeCurrency = profileData.currency || 'USD';
      } else {
        console.warn(
          `Failed to fetch profile for ${symbol}: ${profileResponse.status} ${profileResponse.statusText}`
        );
      }

      // Current price using quote endpoint
      const url = `${config.finnhub.baseUrl}/quote?symbol=${symbol}&token=${apiKey}`;
      const response = await fetch(url);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Finnhub API error for ${symbol}: ${response.status} ${response.statusText}. ${errorText}`
        );
      }

      const data = (await response.json()) as {
        c?: number; // current price
        d?: number; // change
        dp?: number; // percent change
        h?: number; // high
        l?: number; // low
        o?: number; // open
        pc?: number; // previous close
      };

      const price = data.c;

      if (!price || price <= 0) {
        console.warn(`Current price not found for ${symbol}, using 0`);
        return {
          tokenSymbol: symbol,
          baseCurrency: nativeCurrency,
          price: '0',
          timestamp: new Date(),
          source: 'finnhub_quote_unavailable',
        };
      }

      // Return price in its native currency - conversion will be handled at higher level
      return {
        tokenSymbol: symbol,
        baseCurrency: nativeCurrency,
        price: price.toString(),
        timestamp: new Date(),
        source: 'finnhub_quote',
      };
    } else {
      // Get company profile to determine the native currency for historical data too
      const profileUrl = `${config.finnhub.baseUrl}/stock/profile2?symbol=${symbol}&token=${apiKey}`;
      const profileResponse = await fetch(profileUrl);

      let nativeCurrency = 'USD'; // Default fallback
      if (profileResponse.ok) {
        const profileData = (await profileResponse.json()) as {
          currency?: string;
        };
        nativeCurrency = profileData.currency || 'USD';
      }

      // Historical price using candles endpoint
      const fromTimestamp = Math.floor(timestamp.getTime() / 1000);
      const toTimestamp = Math.floor((timestamp.getTime() + 24 * 60 * 60 * 1000) / 1000); // Add 1 day

      const url = `${config.finnhub.baseUrl}/stock/candle?symbol=${symbol}&resolution=D&from=${fromTimestamp}&to=${toTimestamp}&token=${apiKey}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Finnhub API error: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        c?: number[]; // close prices
        h?: number[]; // high prices
        l?: number[]; // low prices
        o?: number[]; // open prices
        s?: string; // status
        t?: number[]; // timestamps
        v?: number[]; // volumes
      };

      if (data.s !== 'ok' || !data.c || data.c.length === 0) {
        console.warn(
          `Historical price not found for ${symbol} on ${
            timestamp.toISOString().split('T')[0]
          }, using 0`
        );
        return {
          tokenSymbol: symbol,
          baseCurrency: nativeCurrency,
          price: '0',
          timestamp,
          source: 'finnhub_candles_unavailable',
        };
      }

      // Get the last available close price
      const price = data.c[data.c.length - 1];

      if (!price || price <= 0) {
        console.warn(
          `Historical price not found for ${symbol} on ${
            timestamp.toISOString().split('T')[0]
          }, using 0`
        );
        return {
          tokenSymbol: symbol,
          baseCurrency: nativeCurrency,
          price: '0',
          timestamp,
          source: 'finnhub_candles_unavailable',
        };
      }

      // Return price in its native currency - conversion will be handled at higher level
      return {
        tokenSymbol: symbol,
        baseCurrency: nativeCurrency,
        price: price.toString(),
        timestamp,
        source: 'finnhub_candles',
      };
    }
  }

  // Forex pricing using ExchangeRate-API (free)
  private async fetchForexPrice(
    fromCurrency: string,
    toCurrency: string,
    timestamp: Date,
    live: boolean
  ): Promise<PriceResult> {
    if (live) {
      const url = `${config.exchangeRate.baseUrl}/latest/${fromCurrency}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`ExchangeRate API error: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        rates?: Record<string, number>;
      };
      const rate = data.rates?.[toCurrency];

      if (!rate) {
        console.warn(`Exchange rate not found for ${fromCurrency}/${toCurrency}, using 0`);
        return {
          tokenSymbol: fromCurrency,
          baseCurrency: toCurrency,
          price: '0',
          timestamp: new Date(),
          source: 'exchangerate_current_unavailable',
        };
      }

      return {
        tokenSymbol: fromCurrency,
        baseCurrency: toCurrency,
        price: rate.toString(),
        timestamp: new Date(),
        source: 'exchangerate_current',
      };
    } else {
      const dateString = timestamp.toISOString().split('T')[0];
      const url = `${config.exchangeRate.baseUrl}/${dateString}/${fromCurrency}`;

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`ExchangeRate API error: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        rates?: Record<string, number>;
      };
      const rate = data.rates?.[toCurrency];

      if (!rate) {
        console.warn(
          `Historical exchange rate not found for ${fromCurrency}/${toCurrency} on ${dateString}, using 0`
        );
        return {
          tokenSymbol: fromCurrency,
          baseCurrency: toCurrency,
          price: '0',
          timestamp,
          source: 'exchangerate_historical_unavailable',
        };
      }

      return {
        tokenSymbol: fromCurrency,
        baseCurrency: toCurrency,
        price: rate.toString(),
        timestamp,
        source: 'exchangerate_historical',
      };
    }
  }

  /**
   * Get conversion rate from one currency to another
   * Handles special cases where providers don't support certain base currencies
   * Returns 0 if conversion is impossible (which will result in 0 value)
   */
  private async getConversionRate(
    fromCurrency: string,
    toCurrency: string,
    timestamp: Date,
    live: boolean
  ): Promise<number> {
    if (fromCurrency === toCurrency) return 1;

    try {
      // Try direct conversion first
      const result = await this.fetchForexPrice(fromCurrency, toCurrency, timestamp, live);
      const rate = parseFloat(result.price);
      return rate > 0 ? rate : 0;
    } catch (error) {
      // If direct conversion fails, try via USD
      if (fromCurrency !== 'USD' && toCurrency !== 'USD') {
        console.warn(
          `Direct conversion ${fromCurrency}->${toCurrency} failed, trying via USD:`,
          error
        );

        try {
          // Convert from -> USD, then USD -> to
          const fromToUsdResult = await this.fetchForexPrice(fromCurrency, 'USD', timestamp, live);
          const usdToToResult = await this.fetchForexPrice('USD', toCurrency, timestamp, live);

          const fromToUsdRate = parseFloat(fromToUsdResult.price);
          const usdToToRate = parseFloat(usdToToResult.price);

          if (fromToUsdRate > 0 && usdToToRate > 0) {
            return fromToUsdRate * usdToToRate;
          } else {
            console.warn(
              `USD conversion yielded zero rates for ${fromCurrency}->${toCurrency}, using 0`
            );
            return 0;
          }
        } catch (usdError) {
          console.warn(`USD conversion also failed for ${fromCurrency}->${toCurrency}:`, usdError);
          console.warn(
            `Cannot convert ${fromCurrency} to ${toCurrency}: both direct and USD-routed conversions failed, using rate 0`
          );
          return 0;
        }
      }

      console.warn(`Currency conversion failed for ${fromCurrency}->${toCurrency}:`, error);
      return 0;
    }
  }

  private async cachePrice(
    tokenId: string,
    baseCurrency: string,
    price: string,
    timestamp: Date,
    source: string
  ): Promise<void> {
    const baseCurrencyToken = await this.getTokenBySymbol(baseCurrency);

    if (!baseCurrencyToken) {
      console.warn(`Base currency token ${baseCurrency} not found, skipping cache`);
      return;
    }

    const newPrice: NewTokenPrice = {
      tokenId,
      baseTokenId: baseCurrencyToken.id,
      price,
      timestamp,
      source,
    };

    try {
      await this.database.insert(tokenPrices).values(newPrice);
    } catch (error) {
      // Ignore duplicate key errors (price already cached)
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!errorMessage.includes('unique constraint')) {
        console.error('Failed to cache price:', error);
      }
    }
  }

  /**
   * Fetch manual price for private tokens
   * Uses the most recent manual price entry from tokenPrices table
   */
  private async fetchManualPrice(
    token: Token,
    baseCurrency: string,
    _timestamp: Date // Unused for manual prices, but kept for interface consistency
  ): Promise<PriceResult> {
    // Get base currency token
    const baseCurrencyToken = await this.getTokenBySymbol(baseCurrency);

    if (!baseCurrencyToken) {
      throw new Error(`Base currency ${baseCurrency} not found`);
    }

    // Find the most recent manual price for this token
    const manualPriceEntries = await this.database
      .select()
      .from(tokenPrices)
      .where(
        and(eq(tokenPrices.tokenId, token.id), eq(tokenPrices.baseTokenId, baseCurrencyToken.id))
      )
      .orderBy(desc(tokenPrices.timestamp))
      .limit(1);

    if (!manualPriceEntries.length) {
      console.warn(
        `No manual price found for private token ${token.symbol}. Using price 0. Please set a price in the token settings.`
      );
      return {
        tokenSymbol: token.symbol,
        baseCurrency: baseCurrency,
        price: '0',
        timestamp: new Date(),
        source: 'manual_unavailable',
      };
    }

    const manualPrice = manualPriceEntries[0]!; // Safe because we checked length above

    return {
      tokenSymbol: token.symbol,
      baseCurrency: baseCurrency,
      price: manualPrice.price,
      timestamp: manualPrice.timestamp,
      source: manualPrice.source || 'manual',
    };
  }
}
