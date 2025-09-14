import { config } from "../config/pricing";

export interface TokenMetadata {
  symbol: string;
  name: string;
  type: "Equity" | "ETF" | "Mutual Fund" | "Bond" | "Commodity" | "Crypto";
  currency: string;
  exchange?: string;
  description?: string;
  provider: "finnhub" | "coingecko";
  providerMetadata: Record<string, unknown>;
}

export interface ValidationResult {
  isValid: boolean;
  metadata?: TokenMetadata;
  error?: string;
}

export class TokenValidationService {
  /**
   * Validate a token symbol using appropriate provider based on token characteristics
   */
  async validateToken(
    symbol: string,
    tokenTypeCode?: string
  ): Promise<ValidationResult> {
    // If we know the token type, use appropriate provider
    if (tokenTypeCode) {
      return tokenTypeCode === "crypto"
        ? this.validateCryptoToken(symbol)
        : this.validateFinnhubToken(symbol);
    }

    // Try both providers if token type is unknown
    // First try Finnhub (stocks, ETFs, etc.)
    const finnhubResult = await this.validateFinnhubToken(symbol);
    if (finnhubResult.isValid) {
      return finnhubResult;
    }

    // Then try CoinGecko (crypto)
    const coinGeckoResult = await this.validateCryptoToken(symbol);
    if (coinGeckoResult.isValid) {
      return coinGeckoResult;
    }

    return {
      isValid: false,
      error: `Token ${symbol} not found in any supported provider (Finnhub, CoinGecko)`,
    };
  }

  /**
   * Validate a token symbol using Finnhub (for stocks, ETFs, bonds, commodities)
   */
  private async validateFinnhubToken(
    symbol: string
  ): Promise<ValidationResult> {
    try {
      const apiKey = config.finnhub.apiKey;

      if (!apiKey) {
        return {
          isValid: false,
          error: "Finnhub API key not configured",
        };
      }

      // First, try to get a quote to see if the symbol exists
      const quoteUrl = `${config.finnhub.baseUrl}/quote?symbol=${symbol}&token=${apiKey}`;
      const quoteResponse = await fetch(quoteUrl);

      if (!quoteResponse.ok) {
        return {
          isValid: false,
          error: `Finnhub API error: ${quoteResponse.statusText}`,
        };
      }

      const quoteData = (await quoteResponse.json()) as {
        c?: number; // current price
        d?: number; // change
        dp?: number; // percent change
        h?: number; // high
        l?: number; // low
        o?: number; // open
        pc?: number; // previous close
      };

      // If no current price, the symbol probably doesn't exist
      if (!quoteData.c || quoteData.c <= 0) {
        return {
          isValid: false,
          error: "Symbol not found in Finnhub database",
        };
      }

      // Try to get company profile for additional metadata
      const profileUrl = `${config.finnhub.baseUrl}/stock/profile2?symbol=${symbol}&token=${apiKey}`;
      const profileResponse = await fetch(profileUrl);

      let profileData: {
        name?: string;
        currency?: string;
        exchange?: string;
        weburl?: string;
      } = {};
      if (profileResponse.ok) {
        profileData = (await profileResponse.json()) as {
          name?: string;
          currency?: string;
          exchange?: string;
          weburl?: string;
        };
      }

      // Determine token type based on available information
      // Finnhub doesn't always provide explicit type information,
      // so we'll default to 'Equity' and let the user specify if needed
      let tokenType: "Equity" | "ETF" | "Mutual Fund" | "Bond" | "Commodity" =
        "Equity";

      // Basic heuristics to determine type
      if (symbol.includes(".") || symbol.length > 4) {
        // Could be international or ETF
        tokenType = "Equity";
      }

      const metadata: TokenMetadata = {
        symbol: symbol,
        name: profileData.name || symbol,
        type: tokenType,
        currency: profileData.currency || "USD",
        exchange: profileData.exchange || "US",
        description: profileData.weburl || undefined,
        provider: "finnhub",
        providerMetadata: {
          quote: quoteData,
          profile: profileData,
          validatedAt: new Date().toISOString(),
        },
      };

      return {
        isValid: true,
        metadata,
      };
    } catch (error) {
      return {
        isValid: false,
        error:
          error instanceof Error ? error.message : "Unknown validation error",
      };
    }
  }

  /**
   * Validate a cryptocurrency token using CoinGecko
   */
  private async validateCryptoToken(symbol: string): Promise<ValidationResult> {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (config.coinGecko.apiKey) {
        headers["x-cg-pro-api-key"] = config.coinGecko.apiKey;
      }

      // Search CoinGecko for the symbol
      const searchUrl = `${config.coinGecko.baseUrl}/search?query=${symbol}`;
      const response = await fetch(searchUrl, { headers });

      if (!response.ok) {
        return {
          isValid: false,
          error: `CoinGecko API error: ${response.statusText}`,
        };
      }

      const searchData = (await response.json()) as {
        coins: Array<{
          id: string;
          symbol: string;
          name: string;
          large?: string;
        }>;
      };

      // Find exact symbol match
      const match = searchData.coins.find(
        (coin) => coin.symbol.toLowerCase() === symbol.toLowerCase()
      );

      if (!match) {
        return {
          isValid: false,
          error: "Cryptocurrency not found in CoinGecko database",
        };
      }

      // Get detailed coin info
      const coinUrl = `${config.coinGecko.baseUrl}/coins/${match.id}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`;
      const coinResponse = await fetch(coinUrl, { headers });

      if (!coinResponse.ok) {
        return {
          isValid: false,
          error: `Failed to fetch coin details from CoinGecko: ${coinResponse.statusText}`,
        };
      }

      const coinData = (await coinResponse.json()) as {
        id: string;
        symbol: string;
        name: string;
        image?: { large?: string };
        market_data?: {
          current_price?: Record<string, number>;
        };
      };

      const metadata: TokenMetadata = {
        symbol: symbol.toUpperCase(),
        name: coinData.name,
        type: "Crypto",
        currency: "USD", // CoinGecko prices are typically in USD
        provider: "coingecko",
        providerMetadata: {
          id: coinData.id,
          coinGeckoData: coinData,
          validatedAt: new Date().toISOString(),
        },
      };

      return {
        isValid: true,
        metadata,
      };
    } catch (error) {
      return {
        isValid: false,
        error:
          error instanceof Error ? error.message : "Unknown validation error",
      };
    }
  }

  /**
   * Alias for validateToken to maintain compatibility
   */
  async getTokenInfo(symbol: string): Promise<ValidationResult> {
    return this.validateToken(symbol);
  }
}
