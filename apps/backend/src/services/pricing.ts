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
   */
  async getTokenPrice(request: PriceRequest): Promise<string> {
    const { tokenSymbol, baseCurrency, timestamp, live = false } = request;

    // First, try to get from cache
    const cachedPrice = await this.getCachedPrice(tokenSymbol, baseCurrency, timestamp);
    if (cachedPrice) {
      return cachedPrice.price;
    }

    // Get token info to determine provider
    const token = await this.getTokenBySymbol(tokenSymbol);
    if (!token) {
      throw new Error(`Token ${tokenSymbol} not found`);
    }

    // If token and base currency are the same, return 1
    if (tokenSymbol.toUpperCase() === baseCurrency.toUpperCase()) {
      return '1';
    }

    // Fetch from appropriate provider based on token type
    const result = await this.fetchPriceFromProvider(token, baseCurrency, timestamp, live);

    // Cache the result
    await this.cachePrice(token.id, baseCurrency, result.price, result.timestamp, result.source);

    return result.price;
  }

  /**
   * Get multiple token prices at once (more efficient)
   */
  async getTokenPrices(requests: PriceRequest[]): Promise<Record<string, string>> {
    const results: Record<string, string> = {};

    // For now, process sequentially. In production, you'd batch by provider
    for (const request of requests) {
      try {
        const price = await this.getTokenPrice(request);
        if (price !== null) {
          results[request.tokenSymbol] = price;
        }
      } catch (error) {
        console.error(`Failed to get price for ${request.tokenSymbol}:`, error);
        // Don't throw, just skip this token
      }
    }

    return results;
  }

  private async getCachedPrice(
    tokenSymbol: string,
    baseCurrency: string,
    timestamp: Date
  ): Promise<{ price: string } | null> {
    const token = await this.getTokenBySymbol(tokenSymbol);
    const baseCurrencyToken = await this.getTokenBySymbol(baseCurrency);

    if (!token || !baseCurrencyToken) return null;

    // Look for price within 1 hour window for current prices, 1 day for historical
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

    switch (tokenType?.code) {
      case 'crypto':
        return this.fetchCryptoPrice(token.symbol, baseCurrency, timestamp, live);
      case 'stock':
      case 'etf':
        return this.fetchStockPrice(token.symbol, baseCurrency, timestamp, live);
      case 'fiat':
        return this.fetchForexPrice(token.symbol, baseCurrency, timestamp, live);
      default:
        throw new Error(`Unsupported token type: ${tokenType?.code}`);
    }
  }

  private async getTokenType(typeId: string) {
    const result = await this.database
      .select()
      .from(tokenTypes)
      .where(eq(tokenTypes.id, typeId))
      .limit(1);
    return result[0] || null;
  }

  // Crypto pricing using CoinGecko (free tier friendly)
  private async fetchCryptoPrice(
    symbol: string,
    baseCurrency: string,
    timestamp: Date,
    live: boolean
  ): Promise<PriceResult> {
    const baseUrl = config.coinGecko.baseUrl;

    if (live) {
      // Current price
      const url = `${baseUrl}/simple/price?ids=${symbol}&vs_currencies=${baseCurrency}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`CoinGecko API error: ${response.statusText}`);
      }

      const data = (await response.json()) as Record<string, Record<string, number>>;
      const price = data[symbol.toLowerCase()]?.[baseCurrency.toLowerCase()];

      if (!price) {
        throw new Error(`Price not found for ${symbol}/${baseCurrency}`);
      }

      return {
        tokenSymbol: symbol,
        baseCurrency,
        price: price.toString(),
        timestamp: new Date(),
        source: 'coingecko_current',
      };
    } else {
      // Historical price
      const dateString = timestamp.toISOString().split('T')[0]; // YYYY-MM-DD
      const url = `${baseUrl}/coins/${symbol}/history?date=${dateString}`;

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`CoinGecko API error: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        market_data?: { current_price?: Record<string, number> };
      };
      const price = data.market_data?.current_price?.[baseCurrency.toLowerCase()];

      if (!price) {
        throw new Error(
          `Historical price not found for ${symbol}/${baseCurrency} on ${dateString}`
        );
      }

      return {
        tokenSymbol: symbol,
        baseCurrency,
        price: price.toString(),
        timestamp,
        source: 'coingecko_historical',
      };
    }
  }

  // Stock/ETF pricing using Alpha Vantage
  private async fetchStockPrice(
    symbol: string,
    baseCurrency: string,
    timestamp: Date,
    live: boolean
  ): Promise<PriceResult> {
    const apiKey = config.alphaVantage.apiKey;

    if (!apiKey) {
      throw new Error('Alpha Vantage API key not configured');
    }

    if (live) {
      // Current price
      const url = `${config.alphaVantage.baseUrl}?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${apiKey}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Alpha Vantage API error: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        'Global Quote'?: { '05. price'?: string };
      };
      const quote = data['Global Quote'];
      const price = parseFloat(quote?.['05. price'] || '0');

      if (!price) {
        throw new Error(`Current price not found for ${symbol}`);
      }

      // Convert to base currency if needed
      const convertedPrice =
        baseCurrency === 'USD'
          ? price.toString()
          : (await this.convertCurrency(price, 'USD', baseCurrency, new Date())).toString();

      return {
        tokenSymbol: symbol,
        baseCurrency,
        price: convertedPrice,
        timestamp: new Date(),
        source: 'alphavantage_quote',
      };
    } else {
      // Historical price
      const dateString = timestamp.toISOString().split('T')[0] || '';
      const url = `${config.alphaVantage.baseUrl}?function=TIME_SERIES_DAILY&symbol=${symbol}&apikey=${apiKey}`;

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Alpha Vantage API error: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        'Time Series (Daily)'?: Record<string, { '4. close'?: string }>;
      };
      const timeSeries = data['Time Series (Daily)'];
      let dayData: { '4. close'?: string } | undefined;
      if (timeSeries && dateString && dateString in timeSeries) {
        dayData = timeSeries[dateString];
      }
      const price = parseFloat(dayData?.['4. close'] || '0');

      if (!price) {
        throw new Error(`Historical price not found for ${symbol} on ${dateString}`);
      }

      // Convert to base currency if needed
      const convertedPrice =
        baseCurrency === 'USD'
          ? price.toString()
          : (await this.convertCurrency(price, 'USD', baseCurrency, timestamp)).toString();

      return {
        tokenSymbol: symbol,
        baseCurrency,
        price: convertedPrice,
        timestamp,
        source: 'alphavantage_daily',
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
        throw new Error(`Exchange rate not found for ${fromCurrency}/${toCurrency}`);
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
        throw new Error(
          `Historical exchange rate not found for ${fromCurrency}/${toCurrency} on ${dateString}`
        );
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

  private async convertCurrency(
    amount: number,
    fromCurrency: string,
    toCurrency: string,
    timestamp: Date
  ): Promise<number> {
    if (fromCurrency === toCurrency) return amount;

    const rate = await this.getTokenPrice({
      tokenSymbol: fromCurrency,
      baseCurrency: toCurrency,
      timestamp,
      live: this.isLivePrice(timestamp),
    });

    return rate ? amount * parseFloat(rate) : amount;
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
}
