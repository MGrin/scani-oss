import Decimal from 'decimal.js';
import { eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { PricingService } from './pricing';
import { getBaseCurrencyToken } from './user-context';

/**
 * Service to update portfolio values with current token prices
 */
export class PortfolioValuationService {
  private pricingService: PricingService;

  constructor() {
    this.pricingService = new PricingService();
  }

  /**
   * Update current prices for all user holdings
   */
  async updateUserPortfolioPrices(userId: string): Promise<void> {
    // Get user's base currency
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);

    if (!user || !user.baseCurrencyId) {
      console.warn(`User ${userId} has no base currency set`);
      return;
    }

    // Get base currency token
    const [baseCurrency] = await db
      .select()
      .from(schema.tokens)
      .where(eq(schema.tokens.id, user.baseCurrencyId))
      .limit(1);

    if (!baseCurrency) {
      console.warn(`Base currency token not found for user ${userId}`);
      return;
    }

    // Get all unique tokens from user's holdings
    const userTokens = await db
      .select({
        tokenId: schema.holdings.tokenId,
        symbol: schema.tokens.symbol,
        name: schema.tokens.name,
      })
      .from(schema.holdings)
      .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
      .where(eq(schema.holdings.userId, userId))
      .groupBy(schema.holdings.tokenId, schema.tokens.symbol, schema.tokens.name);

    // Fetch current prices for all tokens
    const priceRequests = userTokens.map((token) => ({
      tokenSymbol: token.symbol,
      baseCurrency: baseCurrency.symbol,
      timestamp: new Date(),
      live: true,
    }));

    try {
      const prices = await this.pricingService.getTokenPrices(priceRequests);
      console.log(`Updated prices for ${Object.keys(prices).length} tokens for user ${userId}`);
    } catch (error) {
      console.error(`Failed to update portfolio prices for user ${userId}:`, error);
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

    console.log(`Updating portfolio prices for ${users.length} users`);

    for (const user of users) {
      try {
        await this.updateUserPortfolioPrices(user.id);
      } catch (error) {
        console.error(`Failed to update prices for user ${user.id}:`, error);
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
      // Use user context service to get base currency efficiently
      baseCurrency = await getBaseCurrencyToken(userBaseCurrencyId);
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
      })
      .from(schema.holdings)
      .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
      .where(eq(schema.holdings.userId, userId));

    // Batch fetch prices for all tokens that need conversion
    const now = new Date();
    const tokensToPrice = holdings
      .filter((holding) => holding.tokenId !== baseCurrency.id)
      .map((holding) => ({
        tokenSymbol: holding.tokenSymbol,
        baseCurrency: baseCurrency.symbol,
        timestamp: now,
        live: false, // Use cached prices instead of fetching live
      }));

    // Fetch all prices at once
    const priceResults =
      tokensToPrice.length > 0 ? await this.pricingService.getTokenPrices(tokensToPrice) : {};

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
          // Use batched price result
          const priceResult = priceResults[holding.tokenSymbol];
          if (priceResult) {
            currentPrice = priceResult;
            value = balance.mul(new Decimal(currentPrice)).toString();
          }
        }

        if (value) {
          totalValue = totalValue.add(new Decimal(value));
        }

        portfolioHoldings.push({
          tokenSymbol: holding.tokenSymbol,
          balance: balance.toString(),
          currentPrice,
          value,
        });
      } catch (error) {
        console.warn(`Failed to get price for ${holding.tokenSymbol}:`, error);
        // Add holding without price information
        portfolioHoldings.push({
          tokenSymbol: holding.tokenSymbol,
          balance: new Decimal(holding.balance).toString(),
        });
      }
    }

    return {
      totalValue: totalValue.toString(),
      baseCurrency: baseCurrency.symbol,
      holdings: portfolioHoldings,
    };
  }
}
