import type { DatabaseTransaction } from '@scani/db';
import { db } from '@scani/db/connection';
import type { Token } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { Decimal } from '@scani/shared';
import { and, eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { isIncludedInTotal } from '../../lib/holding-inclusion';
import {
  createPortfolioCacheKey,
  createPortfolioRedisKey,
  getOrComputeFromCache,
} from '../../lib/request-cache';
import { effectiveScamProbability, notScamFor } from '../../lib/scam-verdict';
import { PriceReader } from '../pricing/PriceReader';
import { UserService } from '../users/UserService';
import { InTransitService } from './InTransitService';
import { PortfolioValueCache } from './PortfolioValueCache';
import { PortfolioValueVersion } from './PortfolioValueVersion';

// Type for request cache (shared with tRPC context)
export type RequestCache = Map<string, unknown>;

/** One token's price in the base and what dates it; every field absent when unpriced. */
interface LivePrice {
  price: string | null;
  timestamp?: Date;
  source?: string;
  stale?: boolean;
}

type ValuedHolding = {
  tokenId: string;
  token: Token;
};

// Define the return type for portfolio value.
//
// `currentPrice` / `value` are `null` when `PriceReader` has no route from
// the holding's token to the user's base currency. Such holdings are
// EXCLUDED from `totalValue` so the dashboard total reflects only the
// portion of the portfolio we can actually price. The UI is expected
// to render `null` as "—" so the missing-data state is visible —
// never as $0.
export type PortfolioValueResult = {
  totalValue: string;
  baseCurrency: string;
  holdings: Array<{
    holdingId: string;
    accountId: string;
    tokenId: string;
    tokenSymbol: string;
    balance: string;
    currentPrice: string | null;
    value: string | null;
    priceTimestamp?: Date;
    priceSource?: string;
    /**
     * A leg of the route behind `currentPrice` is older than its asset
     * class's horizon (`PriceReader`'s `stale`).
     *
     * `undefined` is NOT "fresh": the holding is unpriced, so there is no
     * price to call old. Three states on purpose — `true` old, `false`
     * judged and fine, absent unknown — because the alternative is an
     * absence that renders identically to good news.
     */
    priceStale?: boolean;
    isActive: boolean;
  }>;
  /**
   * Money answered `internal` to a provider-fed holding that is in neither
   * balance yet (SC-1675). Counted in `totalValue`; absent on an account's own
   * valuation, because the money is in neither account.
   */
  inTransit?: Array<{
    outflowId: string;
    sourceHoldingId: string;
    destinationHoldingId: string;
    tokenId: string;
    tokenSymbol: string;
    sentAt: Date;
    quantity: string;
    currentPrice: string | null;
    value: string | null;
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
 * Per-account margin debt: the sum of the active, priced holdings worth less
 * than zero, the same rule the allocation applies (SC-1463). An account with
 * no debt has no entry. The values are negative; `sumPortfolioValuesByAccount`
 * already nets them, so a summary's assets are its total minus this.
 */
export function sumPortfolioDebtByAccount(
  portfolio: PortfolioValueResult | null
): Map<string, Decimal> {
  const byAccount = new Map<string, Decimal>();
  if (!portfolio) return byAccount;
  for (const holding of portfolio.holdings) {
    if (!holding.isActive || holding.value === null) continue;
    const value = new Decimal(holding.value);
    if (!value.lessThan(0)) continue;
    byAccount.set(
      holding.accountId,
      (byAccount.get(holding.accountId) ?? new Decimal(0)).add(value)
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
  private readonly priceReader = Container.get(PriceReader);
  private readonly userService = Container.get(UserService);
  private readonly portfolioValueCache = Container.get(PortfolioValueCache);
  private readonly portfolioValueVersion = Container.get(PortfolioValueVersion);
  private readonly inTransitService = Container.get(InTransitService);

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
    // Two cache layers wrap the (expensive) computation:
    //   1. `requestCache` — dedupes sibling tRPC procedures within one
    //      batch (e.g. dashboard.getOverview + getAssetAllocation).
    //   2. `portfolioValueCache` — a Redis cache shared across requests and
    //      machines, keyed on a fingerprint of the holdings and prices the
    //      computation reads, so a reload reuses one computation instead of
    //      blocking the single thread for a second or more (SC-1322).
    return getOrComputeFromCache(
      requestCache,
      createPortfolioCacheKey(userId, accountId),
      async () => {
        const [baseCurrencyId, dataVersion] = await Promise.all([
          userBaseCurrencyId ?? this.userService.getBaseCurrency(userId).then((c) => c.id),
          this.portfolioValueVersion.read(userId),
        ]);
        return this.portfolioValueCache.getOrCompute(
          createPortfolioRedisKey(userId, accountId, baseCurrencyId, dataVersion),
          () =>
            this.computePortfolioValueAt(userId, {
              at: new Date(),
              userBaseCurrencyId,
              accountId,
            })
        );
      }
    );
  }

  /** The portfolio valued at `at`. Uncached: `getUserPortfolioValue` is the cached entry. */
  async computePortfolioValueAt(
    userId: string,
    opts: {
      at: Date;
      userBaseCurrencyId?: string;
      /** Values in this currency instead of the user's own: a household's (SC-1647). */
      baseCurrencyId?: string;
      accountId?: string;
      /** Read inside it: the value shadow compares the cache in the same snapshot (SC-1610). */
      tx?: DatabaseTransaction;
    }
  ): Promise<PortfolioValueResult> {
    const { userBaseCurrencyId, accountId } = opts;
    const reader = opts.tx ?? db;
    let baseCurrency: { id: string; symbol: string; name: string };

    if (opts.baseCurrencyId) {
      const [token] = await reader
        .select({ id: schema.tokens.id, symbol: schema.tokens.symbol, name: schema.tokens.name })
        .from(schema.tokens)
        .where(eq(schema.tokens.id, opts.baseCurrencyId))
        .limit(1);
      if (!token) throw new Error('Base currency token not found');
      baseCurrency = token;
    } else if (userBaseCurrencyId) {
      // Use enhanced user context service with caching
      baseCurrency = await this.userService.getBaseCurrency(userId);
    } else {
      // Fallback: get user and base currency in a single query
      const [userWithBaseCurrency] = await reader
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
      notScamFor(),
    ];
    if (accountId) {
      conditions.push(eq(schema.holdings.accountId, accountId));
    }
    const whereConditions = and(...conditions);

    const holdings = await reader
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
        // The owner's score, not the shared one (SC-1160).
        scamProbability: effectiveScamProbability(),
      })
      .from(schema.holdings)
      .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
      .where(whereConditions);

    // Get unique tokens that need pricing (excluding base currency)
    const now = opts.at;
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

    const livePrices = await this.engineLivePrices(holdings, baseCurrency.id, now, opts.tx);

    // Process holdings as a pure map() transformation. `priceResults`
    // is keyed only by tokens that actually resolved to a price — an
    // absent key means the token is unpriceable in the user's base
    // currency, NOT zero. We surface that distinction by returning
    // `currentPrice: null, value: null` for those holdings and
    // excluding them from the aggregated total.
    const portfolioHoldings = holdings.map((holding) => {
      try {
        const balance = new Decimal(holding.balance);

        const live = livePrices.get(holding.tokenId);
        const currentPrice = live?.price ?? null;

        const value =
          currentPrice === null ? null : balance.mul(new Decimal(currentPrice)).toString();

        return {
          holdingId: holding.holdingId,
          accountId: holding.accountId,
          tokenId: holding.tokenId,
          tokenSymbol: holding.tokenSymbol,
          balance: balance.toString(),
          currentPrice,
          value,
          priceTimestamp: live?.timestamp,
          priceSource: live?.source || undefined,
          priceStale: live?.stale,
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
          holdingId: holding.holdingId,
          accountId: holding.accountId,
          tokenId: holding.tokenId,
          tokenSymbol: holding.tokenSymbol,
          balance: balance.toString(),
          currentPrice: null,
          value: null,
          priceTimestamp: undefined,
          priceSource: undefined,
          priceStale: undefined,
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
          { isScamProbability: holding.scamProbability }
        )
      ) {
        return sum.add(new Decimal(computed.value));
      }
      return sum;
    }, new Decimal(0));

    const inTransit = accountId
      ? []
      : await this.transitLines(userId, holdings, livePrices, now, opts.tx);
    const withTransit = inTransit.reduce(
      (sum, line) => (line.value === null ? sum : sum.add(new Decimal(line.value))),
      totalValue
    );

    return {
      totalValue: withTransit.toString(),
      baseCurrency: baseCurrency.symbol,
      holdings: portfolioHoldings,
      ...(inTransit.length > 0 ? { inTransit } : {}),
    };
  }

  /** A transit counts where its destination does: an excluded destination takes it out too. */
  private async transitLines(
    userId: string,
    holdings: ReadonlyArray<
      ValuedHolding & {
        holdingId: string;
        tokenSymbol: string;
        isActive: boolean;
        isHidden: boolean;
        scamProbability: number;
      }
    >,
    livePrices: ReadonlyMap<string, LivePrice>,
    now: Date,
    tx?: DatabaseTransaction
  ): Promise<NonNullable<PortfolioValueResult['inTransit']>> {
    const amounts = await this.inTransitService.amountsAt(userId, [now], tx);
    const lines: NonNullable<PortfolioValueResult['inTransit']> = [];
    for (const amount of amounts) {
      const destination = holdings.find((h) => h.holdingId === amount.destinationHoldingId);
      if (
        destination === undefined ||
        !isIncludedInTotal(
          { isHidden: destination.isHidden, isActive: destination.isActive },
          { isScamProbability: destination.scamProbability }
        )
      ) {
        continue;
      }
      const currentPrice = livePrices.get(amount.tokenId)?.price ?? null;
      lines.push({
        outflowId: amount.outflowId,
        sourceHoldingId: amount.sourceHoldingId,
        destinationHoldingId: amount.destinationHoldingId,
        tokenId: amount.tokenId,
        tokenSymbol: destination.tokenSymbol,
        sentAt: amount.sentAt,
        quantity: amount.quantity.toString(),
        currentPrice,
        value: currentPrice === null ? null : amount.quantity.mul(currentPrice).toString(),
      });
    }
    return lines;
  }
  /** `PriceReader` (foundation A3): the freshest route, dated by its oldest leg, stale by each leg's horizon. */
  private async engineLivePrices(
    holdings: readonly ValuedHolding[],
    baseCurrencyId: string,
    now: Date,
    tx?: DatabaseTransaction
  ): Promise<Map<string, LivePrice>> {
    const tokenIds = [...new Set(holdings.map((h) => h.tokenId))].filter(
      (tokenId) => tokenId !== baseCurrencyId
    );
    const answers = await this.priceReader.at(tokenIds, baseCurrencyId, now, tx);
    const live = new Map<string, LivePrice>([
      [baseCurrencyId, { price: '1', timestamp: now, source: 'Base Currency', stale: false }],
    ]);
    for (const tokenId of tokenIds) {
      const answer = answers.get(tokenId);
      live.set(
        tokenId,
        answer
          ? {
              price: answer.price.toString(),
              timestamp: answer.readingAt,
              source: answer.source ?? undefined,
              stale: answer.stale,
            }
          : { price: null }
      );
    }
    return live;
  }
}
