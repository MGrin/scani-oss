import Decimal from 'decimal.js';
import { eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { PricingService } from './pricing';

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
  async getUserPortfolioValue(userId: string): Promise<{
    totalValue: string;
    baseCurrency: string;
    holdings: Array<{
      tokenSymbol: string;
      balance: string;
      currentPrice?: string;
      value?: string;
    }>;
  }> {
    // Get user's base currency
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);

    if (!user || !user.baseCurrencyId) {
      throw new Error('User has no base currency set');
    }

    // Get base currency token
    const [baseCurrency] = await db
      .select()
      .from(schema.tokens)
      .where(eq(schema.tokens.id, user.baseCurrencyId))
      .limit(1);

    if (!baseCurrency) {
      throw new Error('Base currency token not found');
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

    // Get current prices for all tokens
    const now = new Date();
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
          const priceResult = await this.pricingService.getTokenPrice({
            tokenSymbol: holding.tokenSymbol,
            baseCurrency: baseCurrency.symbol,
            timestamp: now,
            live: true,
          });

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
