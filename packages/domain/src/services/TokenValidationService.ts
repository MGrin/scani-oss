import { createComponentLogger } from '@scani/logging';
import {
  CHAIN_ID_TO_DEFILLAMA,
  config,
  DEFILLAMA_MIN_CONFIDENCE,
  detectFinnhubExchangeInfo,
  fetchWithTimeout,
  PROVIDER_CONFIGS,
} from '@scani/pricing-providers';
import type { TokenMetadata, TokenValidationResult as ValidationResult } from '@scani/shared';
import { Container, Service } from 'typedi';
import { TokenRepository } from '../repositories/TokenRepository';
import { PricingService } from './PricingService';

/**
 * Service for validating tokens from external providers (CoinGecko, Finnhub, DeFiLlama)
 * Uses PricingService for rate-limited API access
 */
@Service()
export class TokenValidationService {
  private readonly logger = createComponentLogger('token-validation');
  private readonly pricingService = Container.get(PricingService);
  readonly _tokenRepository = Container.get(TokenRepository);

  /**
   * Validate a specific token by its CoinGecko ID
   * Use this when user has selected a specific token from search results
   */
  async validateTokenByCoinGeckoId(coinGeckoId: string): Promise<ValidationResult> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (config.coinGecko.apiKey) {
        headers['x-cg-pro-api-key'] = config.coinGecko.apiKey;
      }

      // Get detailed coin info directly by ID
      const coinUrl = `${config.coinGecko.baseUrl}/coins/${coinGeckoId}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`;
      const coinResponse = await this.pricingService.coinGeckoRateLimiter.execute(() =>
        fetch(coinUrl, { headers })
      );

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
        symbol: coinData.symbol.toUpperCase(),
        name: coinData.name,
        type: 'Crypto',
        currency: 'USD',
        provider: 'coingecko',
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
        error: error instanceof Error ? error.message : 'Unknown validation error',
      };
    }
  }

  /**
   * Validate a token symbol using appropriate provider based on token characteristics
   */
  async validateToken(symbol: string, tokenTypeCode?: string): Promise<ValidationResult> {
    // If we know the token type, use appropriate provider
    if (tokenTypeCode) {
      return tokenTypeCode === 'crypto'
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
      error: `Token ${symbol} not found in any supported provider (Finnhub, CoinGecko, DeFiLlama)`,
    };
  }

  /**
   * Validate a token symbol using Finnhub (for stocks, ETFs, bonds, commodities)
   */
  private async validateFinnhubToken(symbol: string): Promise<ValidationResult> {
    try {
      const apiKey = config.finnhub.apiKey;

      if (!apiKey) {
        return {
          isValid: false,
          error: 'Finnhub API key not configured',
        };
      }

      // First, try to get a quote to see if the symbol exists
      const quoteUrl = `${config.finnhub.baseUrl}/quote?symbol=${symbol}&token=${apiKey}`;
      const quoteResponse = await this.pricingService.finnhubRateLimiter.execute(() =>
        fetch(quoteUrl)
      );

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
          error: 'Symbol not found in Finnhub database',
        };
      }

      // Try to get company profile for additional metadata
      const profileUrl = `${config.finnhub.baseUrl}/stock/profile2?symbol=${symbol}&token=${apiKey}`;
      const profileResponse = await this.pricingService.finnhubRateLimiter.execute(() =>
        fetch(profileUrl)
      );

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
      // Note: Using provider metadata type ('Stock', 'ETF', etc.) for metadata,
      // but these all map to 'stock' type in our database
      let tokenType: string = 'Stock';

      // Basic heuristics to determine type
      if (symbol.includes('.') || symbol.length > 4) {
        // Could be international or ETF
        tokenType = 'Stock';
      }

      const metadata: TokenMetadata = {
        symbol: symbol,
        name: profileData.name || symbol,
        type: tokenType,
        currency: profileData.currency || 'USD',
        exchange: profileData.exchange || 'US',
        description: profileData.weburl || undefined,
        provider: 'finnhub',
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
        error: error instanceof Error ? error.message : 'Unknown validation error',
      };
    }
  }

  /**
   * Validate a cryptocurrency token using CoinGecko
   * Note: DeFiLlama fallback requires contract address, which is not available in symbol-only searches
   */
  private async validateCryptoToken(symbol: string): Promise<ValidationResult> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (config.coinGecko.apiKey) {
        headers['x-cg-pro-api-key'] = config.coinGecko.apiKey;
      }

      // Search CoinGecko for the symbol
      const searchUrl = `${config.coinGecko.baseUrl}/search?query=${symbol}`;
      const response = await this.pricingService.coinGeckoRateLimiter.execute(() =>
        fetch(searchUrl, { headers })
      );

      if (!response.ok) {
        this.logger.warn(
          { symbol, status: response.status, statusText: response.statusText },
          'CoinGecko search failed - DeFiLlama fallback requires contract address'
        );
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
          market_cap_rank?: number | null;
        }>;
      };

      // Find exact symbol match with smart prioritization
      const matches = searchData.coins.filter(
        (coin) => coin.symbol.toLowerCase() === symbol.toLowerCase()
      );

      if (matches.length === 0) {
        return {
          isValid: false,
          error: 'Cryptocurrency not found in CoinGecko database',
        };
      }

      // If multiple matches, use the first one as a fallback
      // This method should primarily be used for single-token validation
      // For user selection from multiple options, use validateTokenByCoinGeckoId instead
      const match = matches[0]!; // We know matches has at least one item

      if (matches.length > 1) {
        this.logger.warn(
          {
            symbol,
            matches: matches.length,
            selectedMatch: { id: match.id, name: match.name },
          },
          'Multiple CoinGecko matches found, using first result'
        );
      }

      // Get detailed coin info
      const coinUrl = `${config.coinGecko.baseUrl}/coins/${match.id}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`;
      const coinResponse = await this.pricingService.coinGeckoRateLimiter.execute(() =>
        fetch(coinUrl, { headers })
      );

      if (!coinResponse.ok) {
        this.logger.warn(
          { symbol, coinId: match.id, status: coinResponse.status },
          'Failed to fetch CoinGecko coin details'
        );
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
        type: 'Crypto',
        currency: 'USD', // CoinGecko prices are typically in USD
        provider: 'coingecko',
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
      this.logger.error(
        { symbol, error: error instanceof Error ? error.message : String(error) },
        'CoinGecko validation error - consider using validateTokenByContractAddress if contract address is available'
      );
      return {
        isValid: false,
        error: error instanceof Error ? error.message : 'Unknown validation error',
      };
    }
  }

  /**
   * Search for multiple tokens using Finnhub symbol lookup
   */
  async searchFinnhubTokens(query: string): Promise<ValidationResult[]> {
    try {
      const apiKey = config.finnhub.apiKey;

      if (!apiKey) {
        return [];
      }

      // Use Finnhub's symbol lookup endpoint. Tight timeout (3s) + no
      // retries because this sits on the user-facing search hot path —
      // the router tolerates one provider failing, so a slow Finnhub
      // shouldn't gate the whole search response.
      const searchUrl = `${
        config.finnhub.baseUrl
      }/search?q=${encodeURIComponent(query)}&token=${apiKey}`;
      const response = await this.pricingService.finnhubRateLimiter.execute(() =>
        fetchWithTimeout(searchUrl, undefined, 3000, 0)
      );

      if (!response.ok) {
        this.logger.warn(
          { status: response.status, statusText: response.statusText, query },
          'Finnhub search API error'
        );
        return [];
      }

      const searchData = (await response.json()) as {
        count: number;
        result: Array<{
          description: string;
          displaySymbol: string;
          symbol: string;
          type: string;
        }>;
      };

      if (!searchData.result || searchData.result.length === 0) {
        return [];
      }

      // Convert search results to ValidationResults
      const results: ValidationResult[] = [];

      for (const item of searchData.result.slice(0, 10)) {
        // Limit to 10 results
        // Use provider metadata types for display, but they all map to 'stock' in our database
        // Note: Provider types are preserved in metadata for user information
        let tokenType: string = 'Equity';

        if (item.type) {
          const type = item.type.toLowerCase();
          if (type.includes('etf')) {
            tokenType = 'ETF';
          } else if (type.includes('fund')) {
            tokenType = 'Mutual Fund';
          } else if (type.includes('bond')) {
            tokenType = 'Bond';
          } else if (type.includes('commodity')) {
            tokenType = 'Commodity';
          }
        }

        const finalSymbol = item.displaySymbol || item.symbol;
        // Non-US listings (e.g. XEQT.TO, VOD.L) can't be priced by
        // Finnhub's free tier. Tag them with exchangeInfo so the router
        // can send them to Google Sheets instead.
        const exchangeInfo = detectFinnhubExchangeInfo(finalSymbol);
        const metadata: TokenMetadata = {
          symbol: finalSymbol,
          name: item.description,
          type: tokenType,
          currency: exchangeInfo?.currency ?? 'USD',
          exchange: exchangeInfo?.exchange,
          provider: 'finnhub',
          providerMetadata: {
            searchResult: item,
            validatedAt: new Date().toISOString(),
            ...(exchangeInfo ? { exchangeInfo } : {}),
          },
        };

        results.push({
          isValid: true,
          metadata,
        });
      }

      return results;
    } catch (error) {
      this.logger.warn(
        {
          query,
          error: error instanceof Error ? { name: error.name, message: error.message } : error,
        },
        'Finnhub search error'
      );
      return [];
    }
  }

  /**
   * Search for multiple tokens using CoinGecko search
   */
  async searchCoinGeckoTokens(query: string): Promise<ValidationResult[]> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (config.coinGecko.apiKey) {
        headers['x-cg-pro-api-key'] = config.coinGecko.apiKey;
      }

      // Tight timeout (3s) + no retries — the router's allSettled
      // handling lets a slow CoinGecko fall through without blocking
      // Finnhub / DB results.
      const searchUrl = `${config.coinGecko.baseUrl}/search?query=${encodeURIComponent(query)}`;
      const response = await this.pricingService.coinGeckoRateLimiter.execute(() =>
        fetchWithTimeout(searchUrl, { headers }, 3000, 0)
      );

      if (!response.ok) {
        this.logger.warn(
          { status: response.status, statusText: response.statusText, query },
          'CoinGecko search API error'
        );
        return [];
      }

      const searchData = (await response.json()) as {
        coins: Array<{
          id: string;
          symbol: string;
          name: string;
          large?: string;
        }>;
      };

      if (!searchData.coins || searchData.coins.length === 0) {
        return [];
      }

      // Convert search results to ValidationResults (limit to top 10)
      const results: ValidationResult[] = [];

      for (const coin of searchData.coins.slice(0, 10)) {
        const metadata: TokenMetadata = {
          symbol: coin.symbol.toUpperCase(),
          name: coin.name,
          type: 'Crypto',
          currency: 'USD',
          provider: 'coingecko',
          providerMetadata: {
            id: coin.id,
            searchResult: coin,
            validatedAt: new Date().toISOString(),
          },
        };

        results.push({
          isValid: true,
          metadata,
        });
      }

      return results;
    } catch (error) {
      this.logger.warn(
        {
          query,
          error: error instanceof Error ? { name: error.name, message: error.message } : error,
        },
        'CoinGecko search error'
      );
      return [];
    }
  }

  /**
   * Validate a token by contract address using DeFiLlama
   * This is used as a fallback when CoinGecko is not available or doesn't have the token
   */
  async validateTokenByContractAddress(
    contractAddress: string,
    chainId: number
  ): Promise<ValidationResult> {
    try {
      const chainName = CHAIN_ID_TO_DEFILLAMA[chainId];

      if (!chainName) {
        return {
          isValid: false,
          error: `Chain ${chainId} not supported by DeFiLlama`,
        };
      }

      const key = `${chainName}:${contractAddress.toLowerCase()}`;
      const url = `${PROVIDER_CONFIGS.defiLlama.baseUrl}/prices/current/${key}`;

      const response = await fetchWithTimeout(url, {
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        return {
          isValid: false,
          error: `DeFiLlama API responded with ${response.status}: ${response.statusText}`,
        };
      }

      const data = (await response.json()) as {
        coins: {
          [key: string]: {
            decimals: number;
            symbol: string;
            price: number;
            timestamp: number;
            confidence: number;
          };
        };
      };

      const tokenData = data.coins?.[key];

      if (!tokenData) {
        return {
          isValid: false,
          error: 'Token not found on DeFiLlama',
        };
      }

      // Check confidence score
      if (tokenData.confidence < DEFILLAMA_MIN_CONFIDENCE) {
        return {
          isValid: false,
          error: `Low confidence score from DeFiLlama: ${tokenData.confidence}`,
        };
      }

      // Check for valid price
      if (tokenData.price == null || tokenData.price <= 0) {
        return {
          isValid: false,
          error: 'No valid price data from DeFiLlama',
        };
      }

      const metadata: TokenMetadata = {
        symbol: tokenData.symbol.toUpperCase(),
        // DeFiLlama's current price endpoint doesn't provide full token names
        // This is a known limitation - the symbol is used as name for now
        // Future enhancement: Could make additional API call to get full name if needed
        name: tokenData.symbol,
        type: 'Crypto',
        currency: 'USD',
        provider: 'defillama',
        providerMetadata: {
          contractAddress,
          chainId,
          chainName,
          defiLlamaData: tokenData,
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
        error: error instanceof Error ? error.message : 'Unknown DeFiLlama validation error',
      };
    }
  }
}
