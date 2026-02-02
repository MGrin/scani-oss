import Decimal from 'decimal.js';
import { and, eq, lt } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { SCAM_PROBABILITY_THRESHOLD } from '../config/tokens';
import { db } from '../database/connection';
import * as schema from '../database/schema';
import { TokenPriceRepository } from '../repositories/TokenPriceRepository';
import { createComponentLogger } from '../utils/logger';
import {
  createPortfolioCacheKey,
  getOrComputeFromCache,
  getOrComputeRequestCache,
  hasRequestCache,
} from '../utils/request-cache';
import { PricingService } from './PricingService';
import { UserContextService } from './UserContextService';

// Type for request cache (shared with tRPC context)
export type RequestCache = Map<string, unknown>;

// Define the return type for portfolio value
type PortfolioValueResult = {
  totalValue: string;
  baseCurrency: string;
  holdings: Array<{
    tokenSymbol: string;
    balance: string;
    currentPrice?: string;
    value?: string;
    priceTimestamp?: Date;
    priceSource?: string;
  }>;
};

/**
 * Service to update portfolio values with current token prices
 * Converted to use TypeDI for proper dependency injection
 *
 * PERFORMANCE: Uses request-scoped caching to avoid duplicate pricing calculations
 * within the same HTTP request (e.g., when dashboard.getOverview and
 * dashboard.getAssetAllocation are called in the same batch).
 *
 * IMPORTANT: For tRPC batched requests, pass the ctx.requestCache parameter
 * to ensure all procedures in the batch share the same cache.
 */
@Service()
export class PortfolioValuationService {
  private readonly logger = createComponentLogger('portfolio-valuation');
  private readonly pricingService = Container.get(PricingService);
  private readonly userContextService = Container.get(UserContextService);
  private readonly tokenPriceRepository = Container.get(TokenPriceRepository);

  /**
   * Get user portfolio value with request-scoped caching
   * If the same userId/accountId combination is requested multiple times
   * within the same HTTP request, the cached result is returned.
   *
   * @param userId - The user's ID
   * @param userBaseCurrencyId - Optional user's base currency ID
   * @param accountId - Optional account ID to filter holdings
   * @param requestCache - Optional cache from tRPC context (ctx.requestCache)
   *                       Pass this for proper caching in tRPC batched requests
   */
  async getUserPortfolioValue(
    userId: string,
    userBaseCurrencyId?: string,
    accountId?: string,
    requestCache?: RequestCache
  ): Promise<PortfolioValueResult> {
    const cacheKey = createPortfolioCacheKey(userId, accountId);

    // Priority 1: Use context-provided cache (for tRPC batched requests)
    if (requestCache) {
      return getOrComputeFromCache(requestCache, cacheKey, () =>
        this.computePortfolioValue(userId, userBaseCurrencyId, accountId)
      );
    }

    // Priority 2: Use AsyncLocalStorage-based cache (for non-tRPC contexts like cron jobs)
    if (hasRequestCache()) {
      return getOrComputeRequestCache(cacheKey, () =>
        this.computePortfolioValue(userId, userBaseCurrencyId, accountId)
      );
    }

    // No request cache available, compute directly
    return this.computePortfolioValue(userId, userBaseCurrencyId, accountId);
  }

  /**
   * Internal method that performs the actual portfolio value computation
   */
  private async computePortfolioValue(
    userId: string,
    userBaseCurrencyId?: string,
    accountId?: string
  ): Promise<PortfolioValueResult> {
    let baseCurrency: { id: string; symbol: string; name: string };

    if (userBaseCurrencyId) {
      // Use enhanced user context service with caching
      baseCurrency = await this.userContextService.getBaseCurrency(userId);
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
    // Apply filters:
    // 1. User ownership
    // 2. Exclude hidden holdings (completely hidden from queries)
    // 3. Exclude inactive holdings (visible but not in totals)
    // 4. Filter out scam tokens to match HoldingRepository behavior
    // Optionally filter by account ID if provided
    const conditions = [
      eq(schema.holdings.userId, userId),
      eq(schema.holdings.isHidden, false),
      eq(schema.holdings.isActive, true),
      lt(schema.tokens.isScamProbability, SCAM_PROBABILITY_THRESHOLD),
    ];
    if (accountId) {
      conditions.push(eq(schema.holdings.accountId, accountId));
    }
    const whereConditions = and(...conditions);

    const holdings = await db
      .select({
        holdingId: schema.holdings.id,
        accountId: schema.holdings.accountId,
        balance: schema.holdings.balance,
        tokenId: schema.tokens.id,
        tokenSymbol: schema.tokens.symbol,
        tokenName: schema.tokens.name,
        token: schema.tokens,
      })
      .from(schema.holdings)
      .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
      .where(whereConditions);

    // Get unique tokens that need pricing (excluding base currency)
    const now = new Date();
    const tokensToPrice = holdings
      .filter((holding) => holding.tokenId !== baseCurrency.id)
      .map((holding) => holding.token)
      .filter((token, index, self) => self.findIndex((t) => t.id === token.id) === index);

    this.logger.info(
      {
        userId,
        accountId,
        totalHoldings: holdings.length,
        tokensNeedingPrice: tokensToPrice.length,
        baseCurrency: baseCurrency.symbol,
      },
      accountId
        ? `Processing account portfolio value: ${tokensToPrice.length} tokens need pricing`
        : `Processing portfolio value: ${tokensToPrice.length} tokens need pricing`
    );

    // Fetch all prices at once using cached-only pricing (no external API calls)
    const priceResults =
      tokensToPrice.length > 0
        ? await this.pricingService.getCachedTokenPrices(tokensToPrice, baseCurrency.symbol, now)
        : new Map<string, string>();

    this.logger.info(
      {
        userId,
        accountId,
        pricesFetched: priceResults.size,
        tokensRequested: tokensToPrice.length,
      },
      `Pricing complete: ${priceResults.size}/${tokensToPrice.length} prices retrieved`
    );

    // Fetch price metadata (timestamp and source) from database
    const tokenIds = Array.from(new Set(holdings.map((h) => h.tokenId)));
    const priceMetadata = await this.tokenPriceRepository.findLatestPricesForTokens(
      tokenIds,
      baseCurrency.id
    );

    // HIGH PRIORITY FIX: Process holdings with pure map() transformation
    // This prevents accidental N+1 queries and makes it clear this is data transformation only
    const portfolioHoldings = holdings.map((holding) => {
      try {
        const balance = new Decimal(holding.balance);

        // Determine price based on whether it's base currency or needs lookup
        const currentPrice =
          holding.tokenId === baseCurrency.id
            ? '1' // Base currency is always 1:1
            : priceResults.get(holding.tokenId) || '0'; // Use batched price result

        const value = balance.mul(new Decimal(currentPrice)).toString();

        // Get price metadata for this token
        const priceInfo = priceMetadata.get(holding.tokenId);

        return {
          tokenSymbol: holding.tokenSymbol,
          balance: balance.toString(),
          currentPrice,
          value,
          priceTimestamp: priceInfo?.timestamp,
          priceSource: priceInfo?.source || undefined,
        };
      } catch (error) {
        this.logger.warn(
          {
            userId,
            tokenSymbol: holding.tokenSymbol,
            error: error instanceof Error ? { name: error.name, message: error.message } : error,
          },
          'Failed to process holding while computing portfolio value'
        );

        // Return fallback holding with 0 value
        const balance = new Decimal(holding.balance);
        return {
          tokenSymbol: holding.tokenSymbol,
          balance: balance.toString(),
          currentPrice: '0',
          value: '0',
          priceTimestamp: undefined,
          priceSource: undefined,
        };
      }
    });

    // Calculate total value separately (pure aggregation)
    const totalValue = portfolioHoldings.reduce(
      (sum, holding) => sum.add(new Decimal(holding.value)),
      new Decimal(0)
    );

    return {
      totalValue: totalValue.toString(),
      baseCurrency: baseCurrency.symbol,
      holdings: portfolioHoldings,
    };
  }
}
