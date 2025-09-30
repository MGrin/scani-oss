import Decimal from 'decimal.js';
import { eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { createComponentLogger } from '../utils/logger';
import { type PricingService, pricingService } from './pricing';
import { userContextService } from './user-context-enhanced';

/**
 * Service to update portfolio values with current token prices
 */
export class PortfolioValuationService {
  private pricingService: PricingService;
  private readonly logger = createComponentLogger('portfolio-valuation');

  constructor() {
    this.pricingService = pricingService;
  }

  /**
   * Update current prices for all user holdings
   */
  async updateUserPortfolioPrices(userId: string): Promise<void> {
    try {
      // Get base currency using enhanced cached service
      const baseCurrency = await userContextService.getBaseCurrency(userId);

      // Get current holdings with required token data
      const holdings = await db
        .select({
          id: schema.holdings.id,
          tokenId: schema.holdings.tokenId,
          balance: schema.holdings.balance,
          token: schema.tokens,
        })
        .from(schema.holdings)
        .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
        .where(eq(schema.holdings.userId, userId));

      if (holdings.length === 0) {
        this.logger.debug({ userId }, 'No holdings found for user');
        return;
      }

      // Get unique tokens for price fetching
      const uniqueTokenMap = new Map<string, typeof schema.tokens.$inferSelect>();
      for (const holding of holdings) {
        uniqueTokenMap.set(holding.token.id, holding.token);
      }
      const uniqueTokens = Array.from(uniqueTokenMap.values());

      // Get current prices using the pricing service
      const prices = await this.pricingService.getTokenPrices(
        uniqueTokens,
        baseCurrency.symbol,
        new Date()
      );

      this.logger.info(
        {
          userId,
          pricedTokenCount: prices.size,
          holdingsCount: holdings.length,
        },
        'Updated portfolio token prices for user'
      );
    } catch (error) {
      this.logger.error(
        {
          userId,
          error: error instanceof Error ? { name: error.name, message: error.message } : error,
        },
        'Failed to update portfolio prices for user'
      );
    }
  }
  /**
   * Update current prices for all users' portfolios
   * This could be run as a scheduled job
   */
  async updateAllPortfolioPrices(): Promise<void> {
    // Get all users with base currencies set
    const users = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(isNotNull(schema.users.baseCurrencyId));

    this.logger.info({ userCount: users.length }, 'Updating portfolio prices for all users');

    for (const user of users) {
      try {
        await this.updateUserPortfolioPrices(user.id);
      } catch (error) {
        this.logger.error(
          {
            userId: user.id,
            error: error instanceof Error ? { name: error.name, message: error.message } : error,
          },
          'Failed to update prices for user'
        );
        // Continue with other users
      }
    }
  }

  /**
   * Get current portfolio value for a user
   */
  async getUserPortfolioValue(
    userId: string,
    userBaseCurrencyId?: string
  ): Promise<{
    totalValue: string;
    baseCurrency: string;
    holdings: Array<{
      tokenSymbol: string;
      balance: string;
      currentPrice?: string;
      value?: string;
    }>;
  }> {
    let baseCurrency: { id: string; symbol: string; name: string };

    if (userBaseCurrencyId) {
      // Use enhanced user context service with caching
      baseCurrency = await userContextService.getBaseCurrency(userId);
    } else {
      // Fallback: get user and base currency in a single query
      const [userWithBaseCurrency] = await db
        .select({
          userId: schema.users.id,
          userBaseCurrencyId: schema.users.baseCurrencyId,
          baseCurrencyId: schema.tokens.id,
          baseCurrencySymbol: schema.tokens.symbol,
          baseCurrencyName: schema.tokens.name,
        })
        .from(schema.users)
        .innerJoin(schema.tokens, eq(schema.users.baseCurrencyId, schema.tokens.id))
        .where(eq(schema.users.id, userId))
        .limit(1);

      if (!userWithBaseCurrency) {
        throw new Error('User not found or has no base currency set');
      }

      baseCurrency = {
        id: userWithBaseCurrency.baseCurrencyId,
        symbol: userWithBaseCurrency.baseCurrencySymbol,
        name: userWithBaseCurrency.baseCurrencyName,
      };
    }

    // Get user holdings with token information
    const holdings = await db
      .select({
        holdingId: schema.holdings.id,
        balance: schema.holdings.balance,
        tokenId: schema.tokens.id,
        tokenSymbol: schema.tokens.symbol,
        tokenName: schema.tokens.name,
        token: schema.tokens,
      })
      .from(schema.holdings)
      .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
      .where(eq(schema.holdings.userId, userId));

    // Get unique tokens that need pricing (excluding base currency)
    const now = new Date();
    const tokensToPrice = holdings
      .filter((holding) => holding.tokenId !== baseCurrency.id)
      .map((holding) => holding.token)
      .filter((token, index, self) => self.findIndex((t) => t.id === token.id) === index);

    // Fetch all prices at once using the correct API
    const priceResults =
      tokensToPrice.length > 0
        ? await this.pricingService.getTokenPrices(tokensToPrice, baseCurrency.symbol, now)
        : new Map<string, string>();

    // Process holdings with batched price data
    const portfolioHoldings = [];
    let totalValue = new Decimal(0);

    for (const holding of holdings) {
      try {
        let currentPrice: string | undefined;
        let value: string | undefined;

        const balance = new Decimal(holding.balance);

        // Skip price lookup if token is same as base currency
        if (holding.tokenId === baseCurrency.id) {
          currentPrice = '1';
          value = balance.toString();
        } else {
          // Use batched price result - pricing service now always returns a price (even if 0)
          currentPrice = priceResults.get(holding.tokenId) || '0';
          value = balance.mul(new Decimal(currentPrice)).toString();
        }

        // Always add to total value, even if price is 0
        totalValue = totalValue.add(new Decimal(value));

        portfolioHoldings.push({
          tokenSymbol: holding.tokenSymbol,
          balance: balance.toString(),
          currentPrice,
          value,
        });
      } catch (error) {
        this.logger.warn(
          {
            userId,
            tokenSymbol: holding.tokenSymbol,
            error: error instanceof Error ? { name: error.name, message: error.message } : error,
          },
          'Failed to process holding while computing portfolio value'
        );
        // Add holding with 0 price as fallback
        const balance = new Decimal(holding.balance);
        portfolioHoldings.push({
          tokenSymbol: holding.tokenSymbol,
          balance: balance.toString(),
          currentPrice: '0',
          value: '0',
        });
      }
    }

    return {
      totalValue: totalValue.toString(),
      baseCurrency: baseCurrency.symbol,
      holdings: portfolioHoldings,
    };
  }

  /**
   * Get unpriceable tokens for a user (tokens with 0 prices due to provider limitations)
   */
  async getUnpriceableTokens(
    userId: string,
    userBaseCurrencyId?: string
  ): Promise<{
    count: number;
    tokens: Array<{
      symbol: string;
      balance: string;
      reason: string;
      provider: string;
      providerPricingUrl?: string;
      institutionName: string;
      accountName: string;
    }>;
    baseCurrency: string;
  }> {
    let baseCurrency: { id: string; symbol: string; name: string };

    if (userBaseCurrencyId) {
      baseCurrency = await userContextService.getBaseCurrency(userId);
    } else {
      // Get user and base currency
      const [userWithBaseCurrency] = await db
        .select({
          userId: schema.users.id,
          userBaseCurrencyId: schema.users.baseCurrencyId,
          baseCurrencyId: schema.tokens.id,
          baseCurrencySymbol: schema.tokens.symbol,
          baseCurrencyName: schema.tokens.name,
        })
        .from(schema.users)
        .innerJoin(schema.tokens, eq(schema.users.baseCurrencyId, schema.tokens.id))
        .where(eq(schema.users.id, userId))
        .limit(1);

      if (!userWithBaseCurrency) {
        throw new Error('User not found or has no base currency set');
      }

      baseCurrency = {
        id: userWithBaseCurrency.baseCurrencyId,
        symbol: userWithBaseCurrency.baseCurrencySymbol,
        name: userWithBaseCurrency.baseCurrencyName,
      };
    }

    // Get user holdings with token, account, and institution information
    const holdings = await db
      .select({
        balance: schema.holdings.balance,
        tokenId: schema.tokens.id,
        tokenSymbol: schema.tokens.symbol,
        tokenName: schema.tokens.name,
        accountName: schema.accounts.name,
        institutionName: schema.institutions.name,
      })
      .from(schema.holdings)
      .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
      .innerJoin(schema.accounts, eq(schema.holdings.accountId, schema.accounts.id))
      .innerJoin(schema.institutions, eq(schema.accounts.institutionId, schema.institutions.id))
      .where(eq(schema.holdings.userId, userId));

    // Check prices for tokens that need conversion (exclude base currency)
    const tokensToCheck = holdings.filter((holding) => holding.tokenId !== baseCurrency.id);

    const unpriceableTokens: Array<{
      symbol: string;
      balance: string;
      reason: string;
      provider: string;
      providerPricingUrl?: string;
      institutionName: string;
      accountName: string;
    }> = [];

    if (tokensToCheck.length === 0) {
      return {
        count: 0,
        tokens: [],
        baseCurrency: baseCurrency.symbol,
      };
    }

    // Get unique tokens for metadata checking
    const uniqueTokens = tokensToCheck
      .map((holding) => ({ id: holding.tokenId, symbol: holding.tokenSymbol }))
      .filter((token, index, self) => self.findIndex((t) => t.id === token.id) === index);

    try {
      // Get tokens with their provider metadata to check for pricing limitations
      const tokens = await db
        .select({
          id: schema.tokens.id,
          symbol: schema.tokens.symbol,
          name: schema.tokens.name,
          providerMetadata: schema.tokens.providerMetadata,
        })
        .from(schema.tokens)
        .where(
          inArray(
            schema.tokens.id,
            uniqueTokens.map((t) => t.id)
          )
        );

      // Create a map for quick token lookup
      const tokenMap = new Map(tokens.map((token) => [token.id, token]));

      // Process holdings to find unpriceable tokens based on metadata
      for (const holding of tokensToCheck) {
        const token = tokenMap.get(holding.tokenId);
        if (!token) continue;

        let isUnpriceable = false;
        let reason = '';
        let provider = '';
        let providerPricingUrl: string | undefined;

        // Check if token has provider metadata indicating pricing limitations
        if (token.providerMetadata) {
          try {
            const metadata =
              typeof token.providerMetadata === 'string'
                ? JSON.parse(token.providerMetadata)
                : token.providerMetadata;

            if (metadata.pricingUnavailable) {
              isUnpriceable = true;

              // Extract reason and provider info from metadata
              if (metadata.pricingUnavailable.finnhub?.tierLimitation) {
                reason = metadata.pricingUnavailable.finnhub.reason || 'Finnhub tier limitation';
                provider = 'Finnhub';
                providerPricingUrl = 'https://finnhub.io/pricing';
              } else if (metadata.pricingUnavailable.coinGecko?.unavailable) {
                reason = metadata.pricingUnavailable.coinGecko.reason || 'CoinGecko unavailable';
                provider = 'CoinGecko';
              } else if (metadata.pricingUnavailable.general) {
                reason = metadata.pricingUnavailable.general.reason || 'Provider limitation';
                provider = metadata.pricingUnavailable.general.provider || 'Multiple providers';
              } else {
                // Fallback if metadata structure is different - try to extract provider info
                if (metadata.pricingUnavailable.provider) {
                  provider = metadata.pricingUnavailable.provider;
                  reason =
                    metadata.pricingUnavailable.reason ||
                    metadata.pricingUnavailable.message ||
                    `Pricing unavailable from ${provider}`;
                  if (metadata.pricingUnavailable.requiresPremium) {
                    providerPricingUrl = 'https://finnhub.io/pricing';
                  }
                } else {
                  // Last resort: use heuristic detection for proper provider identification
                  const heuristicInfo = this.getProviderInfoHeuristic(token.symbol);
                  reason = heuristicInfo.reason;
                  provider = heuristicInfo.provider;
                  providerPricingUrl = heuristicInfo.pricingUrl;
                }
              }
            }
          } catch (parseError) {
            // If metadata can't be parsed, fall back to heuristic detection
            this.logger.warn(
              {
                tokenId: token.id,
                symbol: token.symbol,
                error:
                  parseError instanceof Error
                    ? { name: parseError.name, message: parseError.message }
                    : parseError,
              },
              'Failed to parse provider metadata for token'
            );
            // Use heuristic detection as fallback
            const heuristicInfo = this.getProviderInfoHeuristic(token.symbol);
            if (heuristicInfo.isLikelyUnpriceable) {
              isUnpriceable = true;
              reason = heuristicInfo.reason;
              provider = heuristicInfo.provider;
              providerPricingUrl = heuristicInfo.pricingUrl;
            }
          }
        }

        // If no metadata indicates limitations, use heuristic detection as fallback
        if (!isUnpriceable) {
          const heuristicInfo = this.getProviderInfoHeuristic(token.symbol);
          if (heuristicInfo.isLikelyUnpriceable) {
            isUnpriceable = true;
            reason = heuristicInfo.reason;
            provider = heuristicInfo.provider;
            providerPricingUrl = heuristicInfo.pricingUrl;
          }
        }

        // Add to unpriceable tokens if determined to be unpriceable
        if (isUnpriceable) {
          unpriceableTokens.push({
            symbol: holding.tokenSymbol,
            balance: new Decimal(holding.balance).toString(),
            reason,
            provider,
            providerPricingUrl,
            institutionName: holding.institutionName,
            accountName: holding.accountName,
          });
        }
      }
    } catch (error) {
      this.logger.error(
        {
          userId,
          error: error instanceof Error ? { name: error.name, message: error.message } : error,
        },
        'Failed to check token metadata for pricing limitations'
      );
      // Fallback: use heuristic detection for all tokens
      for (const holding of tokensToCheck) {
        const heuristicInfo = this.getProviderInfoHeuristic(holding.tokenSymbol);
        if (heuristicInfo.isLikelyUnpriceable) {
          unpriceableTokens.push({
            symbol: holding.tokenSymbol,
            balance: new Decimal(holding.balance).toString(),
            reason: heuristicInfo.reason,
            provider: heuristicInfo.provider,
            providerPricingUrl: heuristicInfo.pricingUrl,
            institutionName: holding.institutionName,
            accountName: holding.accountName,
          });
        }
      }
    }

    return {
      count: unpriceableTokens.length,
      tokens: unpriceableTokens,
      baseCurrency: baseCurrency.symbol,
    };
  }

  /**
   * Get provider information and reasoning for potentially unpriceable tokens using heuristics
   */
  private getProviderInfoHeuristic(symbol: string): {
    isLikelyUnpriceable: boolean;
    reason: string;
    provider: string;
    pricingUrl?: string;
  } {
    const symbolUpper = symbol.toUpperCase();

    if (symbolUpper.endsWith('.TO') || symbolUpper.endsWith('.TSX')) {
      return {
        isLikelyUnpriceable: true,
        reason: 'Canadian market (TSX) requires premium Finnhub plan',
        provider: 'Finnhub',
        pricingUrl: 'https://finnhub.io/pricing',
      };
    }

    if (
      symbolUpper.includes('.') &&
      !symbolUpper.includes('USDT') &&
      !symbolUpper.includes('USDC')
    ) {
      return {
        isLikelyUnpriceable: true,
        reason: 'International market requires premium Finnhub plan',
        provider: 'Finnhub',
        pricingUrl: 'https://finnhub.io/pricing',
      };
    }

    if (symbolUpper.includes('PRIVATE') || symbolUpper.includes('UNLISTED')) {
      return {
        isLikelyUnpriceable: true,
        reason: 'Private/unlisted security not available via data providers',
        provider: 'Manual Entry Only',
      };
    }

    // For common symbols that should be priceable, return false
    // This includes major cryptocurrencies and US stocks
    const commonSymbols = ['BTC', 'ETH', 'USDT', 'USDC', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA'];
    if (
      commonSymbols.includes(symbolUpper) ||
      (!symbolUpper.includes('.') && symbolUpper.length <= 5)
    ) {
      return {
        isLikelyUnpriceable: false,
        reason: 'Should be available via standard providers',
        provider: 'Finnhub/CoinGecko',
      };
    }

    // Default: might have limited coverage but not necessarily unpriceable
    return {
      isLikelyUnpriceable: false,
      reason: 'Standard coverage expected',
      provider: 'Finnhub/CoinGecko',
    };
  }
}

// ================================================================
// SINGLETON INSTANCE
// ================================================================

export const portfolioValuationService = new PortfolioValuationService();
