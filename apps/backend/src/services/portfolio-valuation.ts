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
        live: true, // Fetch current prices, respecting 1-hour cache
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
          // Use batched price result - pricing service now always returns a price (even if 0)
          const priceResult = priceResults[holding.tokenSymbol];
          currentPrice = priceResult || '0'; // Fallback to 0 if somehow missing
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
        console.warn(`Failed to process holding for ${holding.tokenSymbol}:`, error);
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
      baseCurrency = await getBaseCurrencyToken(userBaseCurrencyId);
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

    for (const holding of tokensToCheck) {
      try {
        const price = await this.pricingService.getTokenPrice({
          tokenSymbol: holding.tokenSymbol,
          baseCurrency: baseCurrency.symbol,
          timestamp: new Date(),
          live: true,
        });

        // If price is 0, it means the token is unpriceable
        if (price === '0') {
          const providerInfo = this.getProviderInfo(holding.tokenSymbol);
          unpriceableTokens.push({
            symbol: holding.tokenSymbol,
            balance: new Decimal(holding.balance).toString(),
            reason: providerInfo.reason,
            provider: providerInfo.provider,
            providerPricingUrl: providerInfo.pricingUrl,
            institutionName: holding.institutionName,
            accountName: holding.accountName,
          });
        }
      } catch {
        // If there's an error, consider it unpriceable
        unpriceableTokens.push({
          symbol: holding.tokenSymbol,
          balance: new Decimal(holding.balance).toString(),
          reason: 'API error or provider limitation',
          provider: 'Unknown',
          institutionName: holding.institutionName,
          accountName: holding.accountName,
        });
      }
    }

    return {
      count: unpriceableTokens.length,
      tokens: unpriceableTokens,
      baseCurrency: baseCurrency.symbol,
    };
  }

  /**
   * Get provider information and reasoning for unpriceable tokens
   */
  private getProviderInfo(symbol: string): {
    reason: string;
    provider: string;
    pricingUrl?: string;
  } {
    const symbolUpper = symbol.toUpperCase();

    if (symbolUpper.endsWith('.TO') || symbolUpper.endsWith('.TSX')) {
      return {
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
        reason: 'International market requires premium Finnhub plan',
        provider: 'Finnhub',
        pricingUrl: 'https://finnhub.io/pricing',
      };
    }

    if (symbolUpper.includes('PRIVATE') || symbolUpper.includes('UNLISTED')) {
      return {
        reason: 'Private/unlisted security not available via data providers',
        provider: 'Manual Entry Only',
      };
    }

    return {
      reason: 'Limited coverage on free tier of data providers',
      provider: 'Finnhub/CoinGecko',
      pricingUrl: 'https://finnhub.io/pricing',
    };
  }
}
