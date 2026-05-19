import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import Decimal from 'decimal.js';
import { and, eq, lt } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { SCAM_PROBABILITY_THRESHOLD } from '../../lib/constants';
import { isIncludedInTotal } from '../../lib/holding-inclusion';
import { getOrComputeFromCache } from '../../lib/request-cache';
import { TokenPriceRepository } from '../../repositories/TokenPriceRepository';
import { PricingService } from '../pricing/PricingService';
import { UserService } from '../users/UserService';

// Type for request cache (shared with tRPC context)
export type RequestCache = Map<string, unknown>;

// Define the return type for portfolio value.
//
// `currentPrice` / `value` are `null` when the holding's token has no
// resolvable price in the user's base currency (no cached price, no
// stale fallback, no usable fiat-pair rate). Such holdings are
// EXCLUDED from `totalValue` so the dashboard total reflects only the
// portion of the portfolio we can actually price. The UI is expected
// to render `null` as "—" so the missing-data state is visible —
// never as $0.
export type PortfolioValueResult = {
  totalValue: string;
  baseCurrency: string;
  holdings: Array<{
    accountId: string;
    tokenSymbol: string;
    balance: string;
    currentPrice: string | null;
    value: string | null;
    priceTimestamp?: Date;
    priceSource?: string;
    isActive: boolean;
  }>;
};

/**
 * Buckets a whole-user portfolio valuation into per-account current
 * totals. Mirrors the aggregate rule used for `totalValue` — only
 * active, priceable holdings contribute. Lets account/institution
 * summaries derive live current values from a single valuation pass.
 */
export function sumPortfolioValuesByAccount(
  portfolio: PortfolioValueResult | null
): Map<string, Decimal> {
  const byAccount = new Map<string, Decimal>();
  if (!portfolio) return byAccount;
  for (const holding of portfolio.holdings) {
    if (!holding.isActive || holding.value === null) continue;
    byAccount.set(
      holding.accountId,
      (byAccount.get(holding.accountId) ?? new Decimal(0)).add(holding.value)
    );
  }
  return byAccount;
}

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
  private readonly userService = Container.get(UserService);
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
    // Cache key is local to this service — keyed on (user, accountId) so
    // sibling tRPC procedures in the same batch share one computation.
    // accountId may be undefined (whole-portfolio view) which collapses
    // to the same key correctly.
    const cacheKey = accountId ? `portfolio:${userId}:${accountId}` : `portfolio:${userId}`;
    return getOrComputeFromCache(requestCache, cacheKey, () =>
      this.computePortfolioValue(userId, userBaseCurrencyId, accountId)
    );
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
      baseCurrency = await this.userService.getBaseCurrency(userId);
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
    // 3. Filter out scam tokens to match HoldingRepository behavior
    // Optionally filter by account ID if provided
    //
    // Inactive holdings are intentionally INCLUDED here so their tokens
    // get priced and their per-holding `value` can be displayed in
    // lists. They're excluded only from the aggregated `totalValue` sum
    // further down.
    const conditions = [
      eq(schema.holdings.userId, userId),
      eq(schema.holdings.isHidden, false),
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
        isActive: schema.holdings.isActive,
        isHidden: schema.holdings.isHidden,
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

    // Fetch price metadata (timestamp and source) from database.
    // The strict base-currency query misses manual prices recorded
    // under a different base (e.g. a custom token priced in EUR while
    // the user views in USD — `getCachedTokenPrices` converts the
    // value on the fly via `findLatestManualPricesForTokensAnyBase`,
    // but the metadata lookup below has to follow the same fallback
    // or the holding comes back with `priceTimestamp`/`priceSource`
    // undefined and the UI renders the price column as "-".
    const tokenIds = Array.from(new Set(holdings.map((h) => h.tokenId)));
    const priceMetadata = await this.tokenPriceRepository.findLatestPricesForTokens(
      tokenIds,
      baseCurrency.id
    );
    const tokensWithoutMetadata = tokenIds.filter((id) => !priceMetadata.has(id));
    if (tokensWithoutMetadata.length > 0) {
      const manualAnyBase =
        await this.tokenPriceRepository.findLatestManualPricesForTokensAnyBase(
          tokensWithoutMetadata
        );
      for (const [tokenId, price] of manualAnyBase.entries()) {
        priceMetadata.set(tokenId, price);
      }
    }

    // Process holdings as a pure map() transformation. `priceResults`
    // is keyed only by tokens that actually resolved to a price — an
    // absent key means the token is unpriceable in the user's base
    // currency, NOT zero. We surface that distinction by returning
    // `currentPrice: null, value: null` for those holdings and
    // excluding them from the aggregated total.
    const portfolioHoldings = holdings.map((holding) => {
      try {
        const balance = new Decimal(holding.balance);

        const currentPrice =
          holding.tokenId === baseCurrency.id ? '1' : (priceResults.get(holding.tokenId) ?? null);

        const value =
          currentPrice === null ? null : balance.mul(new Decimal(currentPrice)).toString();

        const priceInfo = priceMetadata.get(holding.tokenId);

        return {
          accountId: holding.accountId,
          tokenSymbol: holding.tokenSymbol,
          balance: balance.toString(),
          currentPrice,
          value,
          priceTimestamp: priceInfo?.timestamp,
          priceSource: priceInfo?.source || undefined,
          isActive: holding.isActive,
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

        // Computation error: surface as unpriceable rather than $0.
        const balance = new Decimal(holding.balance);
        return {
          accountId: holding.accountId,
          tokenSymbol: holding.tokenSymbol,
          balance: balance.toString(),
          currentPrice: null,
          value: null,
          priceTimestamp: undefined,
          priceSource: undefined,
          isActive: holding.isActive,
        };
      }
    });

    // Total aggregates PRICEABLE holdings that pass the shared
    // inclusion contract (`isIncludedInTotal` — excludes hidden,
    // inactive, and scam). Excluded or unpriceable holdings still
    // appear in the list (so the UI can render them as "—") but
    // contribute nothing to the sum. The historical chart applies the
    // same contract so its latest point reconciles with this total.
    // Reduce over the raw `holdings` rows (which carry the holding +
    // token flags the contract needs); `portfolioHoldings[i]`
    // corresponds by index since it is a 1:1 `map` of `holdings`.
    const totalValue = holdings.reduce((sum, holding, i) => {
      const computed = portfolioHoldings[i];
      if (
        computed?.value != null &&
        isIncludedInTotal(
          { isHidden: holding.isHidden, isActive: holding.isActive },
          { isScamProbability: holding.token.isScamProbability }
        )
      ) {
        return sum.add(new Decimal(computed.value));
      }
      return sum;
    }, new Decimal(0));

    return {
      totalValue: totalValue.toString(),
      baseCurrency: baseCurrency.symbol,
      holdings: portfolioHoldings,
    };
  }
}
