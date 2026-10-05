import { type DatabaseTransaction, getDb } from '@scani/db';
import type {
  CoverageQuality,
  NewPortfolioValueDaily,
  PortfolioValueDaily,
} from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { Service } from 'typedi';
import { includedInTotalSql } from '../lib/holding-inclusion';

export interface ScopeFilter {
  kind: 'user' | 'institution' | 'account' | 'holding';
  id: string;
}

// One `scope_kind='holding'` rollup row, already filtered by the shared
// inclusion contract. Returned by `findIncludedHoldingScopeRange`; the
// chart router groups these by `snapshotDate`.
export interface IncludedHoldingScopeRow {
  snapshotDate: string;
  holdingId: string;
  totalValue: string;
  costBasis: string | null;
  realizedPnl: string | null;
  unrealizedPnl: string | null;
  coverageQuality: CoverageQuality;
  holdingsWithKnownValue: number;
  holdingsTotal: number;
  holdingsUnpriceable: number;
  holdingsStalePriced: number;
  /** SC-249. NULL on rows written before the rollup carried provenance. */
  holdingsStaleAnchored?: number | null;
  /** SC-249. NULL when none were backward-anchored, or the row predates it. */
  oldestAnchorAt?: Date | null;
  /** SC-317. NULL on rows written before the rollup counted this cause. */
  holdingsBeforeRecords?: number | null;
  /** SC-475. NULL on rows written before the rollup counted this cause. */
  holdingsInterpolated?: number | null;
  holdingsBasisUnknown: number;
  transfersUnreviewed: number;
}

/**
 * One day of `IncludedHoldingScopeRow`s summed in SQL (SC-1369). Home read
 * every holding's row for every day and summed them in JS: 49,988 rows for
 * one user's year, and decoding them was most of the api's CPU per Home load.
 * The inclusion contract is the same WHERE clause; only the summing moved.
 *
 * The money columns are `text`; they are summed as `numeric`, which is exact
 * and keeps the widest scale of its inputs (`150.0000000000`), and
 * `aggregateDailyTotals` normalises that back to Decimal's printing. The PnL
 * three are NULL unless every row that day carries all three, and the two
 * provenance counts are NULL if any row that day predates their column.
 */
export interface IncludedDailyTotalsRow {
  snapshotDate: string;
  totalValue: string;
  costBasis: string | null;
  realizedPnl: string | null;
  unrealizedPnl: string | null;
  holdingsWithKnownValue: number;
  holdingsTotal: number;
  holdingsUnpriceable: number;
  holdingsStalePriced: number;
  holdingsStaleAnchored: number | null;
  oldestAnchorAt: Date | null;
  holdingsBeforeRecords: number | null;
  holdingsBasisUnknown: number;
  transfersUnreviewed: number;
  /** Any row that day was partial, stale-priced, stale-anchored or before records. */
  anyPartial: boolean;
}

/** The columns `ReturnsService` reads from a per-holding row (SC-1369). */
export type IncludedHoldingValueRow = Omit<
  IncludedHoldingScopeRow,
  | 'costBasis'
  | 'realizedPnl'
  | 'unrealizedPnl'
  | 'oldestAnchorAt'
  | 'holdingsUnpriceable'
  | 'holdingsBasisUnknown'
>;

const daily = schema.portfolioValueDaily;

// Every column the rollup derives. The PnL three are here because leaving them
// out once left them stale on a re-run (the rollup wrote them on INSERT only).
const DERIVED_COLUMNS = [
  'totalValue',
  'coverageQuality',
  'holdingsWithKnownValue',
  'holdingsTotal',
  'holdingsUnpriceable',
  'holdingsStalePriced',
  'holdingsStaleAnchored',
  'oldestAnchorAt',
  'holdingsBeforeRecords',
  'holdingsInterpolated',
  'holdingsBasisUnknown',
  'transfersUnreviewed',
  'costBasis',
  'realizedPnl',
  'unrealizedPnl',
] as const;

const excluded = (key: (typeof DERIVED_COLUMNS)[number]) => sql.raw(`EXCLUDED.${daily[key].name}`);

const ON_ROLLUP_CONFLICT = {
  target: [daily.userId, daily.scopeKind, daily.scopeId, daily.snapshotDate, daily.baseCurrencyId],
  set: {
    ...Object.fromEntries(DERIVED_COLUMNS.map((key) => [key, excluded(key)])),
    computedAt: sql`now()`,
  },
  setWhere: sql`(${sql.join(
    DERIVED_COLUMNS.map((key) => daily[key]),
    sql`, `
  )}) IS DISTINCT FROM (${sql.join(DERIVED_COLUMNS.map(excluded), sql`, `)})`,
};

// Composite primary key (user_id, snapshot_date, base_currency_id); can't use
// BaseRepository.
@Service()
export class PortfolioValueDailyRepository {
  private readonly logger = createComponentLogger('repository:PortfolioValueDailyRepository');

  private getDb(transaction?: DatabaseTransaction) {
    return transaction || getDb();
  }

  async findRange(
    userId: string,
    baseCurrencyId: string,
    from: Date,
    to: Date,
    transaction?: DatabaseTransaction,
    scope?: ScopeFilter
  ): Promise<PortfolioValueDaily[]> {
    try {
      const db = this.getDb(transaction);
      // Cast the Date boundaries to 'YYYY-MM-DD' to match the `date` column type.
      const fromStr = from.toISOString().slice(0, 10);
      const toStr = to.toISOString().slice(0, 10);
      const effectiveScope = scope ?? { kind: 'user' as const, id: userId };
      const results = await db
        .select()
        .from(schema.portfolioValueDaily)
        .where(
          and(
            eq(schema.portfolioValueDaily.userId, userId),
            eq(schema.portfolioValueDaily.scopeKind, effectiveScope.kind),
            eq(schema.portfolioValueDaily.scopeId, effectiveScope.id),
            eq(schema.portfolioValueDaily.baseCurrencyId, baseCurrencyId),
            gte(schema.portfolioValueDaily.snapshotDate, fromStr),
            lte(schema.portfolioValueDaily.snapshotDate, toStr)
          )
        )
        .orderBy(asc(schema.portfolioValueDaily.snapshotDate));
      return results as PortfolioValueDaily[];
    } catch (error) {
      this.logger.error(
        { userId, baseCurrencyId, from, to, error: error instanceof Error ? error.message : error },
        'Failed to find portfolio_value_daily range'
      );
      throw error;
    }
  }

  // Per-holding (`scope_kind='holding'`) rollup rows for the chart,
  // pre-filtered by the shared inclusion contract (`includedInTotalSql`):
  // owner-hidden, inactive and scam holdings are left out. The caller
  // groups these by snapshot_date to build the user-wide series, so the
  // chart total reconciles with the dashboard headline (which applies
  // the same contract via `isIncludedInTotal`).
  //
  // `holdingIds` narrows the same query to a subset — a group, a vault, one
  // account (SC-457). It is a NARROWING of the inclusion contract and never a
  // way around it: the contract still applies, so a scope naming an
  // owner-hidden holding gets the same answer as one that does not name it.
  // An empty array is a scope with nothing in it and returns nothing;
  // `undefined` is "no scope filter" and returns everything.
  async findIncludedHoldingScopeRange(
    userId: string,
    baseCurrencyId: string,
    from: Date,
    to: Date,
    transaction?: DatabaseTransaction,
    holdingIds?: readonly string[]
  ): Promise<IncludedHoldingScopeRow[]> {
    if (holdingIds !== undefined && holdingIds.length === 0) return [];
    try {
      const results = await this.getDb(transaction)
        .select({
          snapshotDate: daily.snapshotDate,
          holdingId: daily.scopeId,
          totalValue: daily.totalValue,
          costBasis: daily.costBasis,
          realizedPnl: daily.realizedPnl,
          unrealizedPnl: daily.unrealizedPnl,
          coverageQuality: daily.coverageQuality,
          holdingsWithKnownValue: daily.holdingsWithKnownValue,
          holdingsTotal: daily.holdingsTotal,
          holdingsUnpriceable: daily.holdingsUnpriceable,
          holdingsStalePriced: daily.holdingsStalePriced,
          holdingsStaleAnchored: daily.holdingsStaleAnchored,
          oldestAnchorAt: daily.oldestAnchorAt,
          holdingsBeforeRecords: daily.holdingsBeforeRecords,
          holdingsInterpolated: daily.holdingsInterpolated,
          holdingsBasisUnknown: daily.holdingsBasisUnknown,
          transfersUnreviewed: daily.transfersUnreviewed,
        })
        .from(daily)
        .innerJoin(schema.holdings, eq(schema.holdings.id, daily.scopeId))
        .innerJoin(schema.tokens, eq(schema.tokens.id, schema.holdings.tokenId))
        .where(this.includedHoldingRows(userId, baseCurrencyId, from, to, holdingIds))
        .orderBy(asc(daily.snapshotDate));
      return results as IncludedHoldingScopeRow[];
    } catch (error) {
      this.logger.error(
        { userId, baseCurrencyId, from, to, error: error instanceof Error ? error.message : error },
        'Failed to find included holding-scope portfolio_value_daily range'
      );
      throw error;
    }
  }

  /**
   * `findIncludedHoldingScopeRange` narrowed to what `ReturnsService` reads
   * (SC-1369). Returns needs rows per holding, so it cannot take day sums, but
   * it read seventeen columns per row and used eleven. The six it never read
   * include the only timestamp, and the date comes back as text, so neither
   * pays a Date parse per row.
   */
  async findIncludedHoldingValueRange(
    userId: string,
    baseCurrencyId: string,
    from: Date,
    to: Date,
    holdingIds?: readonly string[],
    transaction?: DatabaseTransaction
  ): Promise<IncludedHoldingValueRow[]> {
    if (holdingIds !== undefined && holdingIds.length === 0) return [];
    try {
      const results = await this.getDb(transaction)
        .select({
          snapshotDate: sql<string>`${daily.snapshotDate}::text`,
          holdingId: daily.scopeId,
          totalValue: daily.totalValue,
          coverageQuality: daily.coverageQuality,
          holdingsWithKnownValue: daily.holdingsWithKnownValue,
          holdingsTotal: daily.holdingsTotal,
          holdingsStalePriced: daily.holdingsStalePriced,
          holdingsStaleAnchored: daily.holdingsStaleAnchored,
          holdingsBeforeRecords: daily.holdingsBeforeRecords,
          holdingsInterpolated: daily.holdingsInterpolated,
          transfersUnreviewed: daily.transfersUnreviewed,
        })
        .from(daily)
        .innerJoin(schema.holdings, eq(schema.holdings.id, daily.scopeId))
        .innerJoin(schema.tokens, eq(schema.tokens.id, schema.holdings.tokenId))
        .where(this.includedHoldingRows(userId, baseCurrencyId, from, to, holdingIds))
        .orderBy(asc(daily.snapshotDate));
      return results as IncludedHoldingValueRow[];
    } catch (error) {
      this.logger.error(
        { userId, baseCurrencyId, from, to, error: error instanceof Error ? error.message : error },
        'Failed to find included holding values in portfolio_value_daily'
      );
      throw error;
    }
  }

  /** The included holdings' rows summed per day, in SQL. See `IncludedDailyTotalsRow`. */
  async findIncludedHoldingDailyTotals(
    userId: string,
    baseCurrencyId: string,
    from: Date,
    to: Date,
    transaction?: DatabaseTransaction
  ): Promise<IncludedDailyTotalsRow[]> {
    const pnlComplete = sql`bool_and(${daily.costBasis} IS NOT NULL AND ${daily.realizedPnl} IS NOT NULL AND ${daily.unrealizedPnl} IS NOT NULL)`;
    try {
      return await this.getDb(transaction)
        .select({
          snapshotDate: sql<string>`${daily.snapshotDate}::text`,
          totalValue: sql<string>`sum(${daily.totalValue}::numeric)::text`,
          costBasis: sql<
            string | null
          >`CASE WHEN ${pnlComplete} THEN sum(${daily.costBasis}::numeric)::text END`,
          realizedPnl: sql<
            string | null
          >`CASE WHEN ${pnlComplete} THEN sum(${daily.realizedPnl}::numeric)::text END`,
          unrealizedPnl: sql<
            string | null
          >`CASE WHEN ${pnlComplete} THEN sum(${daily.unrealizedPnl}::numeric)::text END`,
          holdingsWithKnownValue: sql<number>`sum(${daily.holdingsWithKnownValue})::int`,
          holdingsTotal: sql<number>`sum(${daily.holdingsTotal})::int`,
          holdingsUnpriceable: sql<number>`sum(${daily.holdingsUnpriceable})::int`,
          holdingsStalePriced: sql<number>`sum(${daily.holdingsStalePriced})::int`,
          holdingsStaleAnchored: sql<
            number | null
          >`CASE WHEN bool_or(${daily.holdingsStaleAnchored} IS NULL) THEN NULL ELSE sum(${daily.holdingsStaleAnchored})::int END`,
          oldestAnchorAt: sql<Date | null>`min(${daily.oldestAnchorAt})`.mapWith(
            daily.oldestAnchorAt
          ),
          holdingsBeforeRecords: sql<
            number | null
          >`CASE WHEN bool_or(${daily.holdingsBeforeRecords} IS NULL) THEN NULL ELSE sum(${daily.holdingsBeforeRecords})::int END`,
          holdingsBasisUnknown: sql<number>`sum(${daily.holdingsBasisUnknown})::int`,
          transfersUnreviewed: sql<number>`sum(${daily.transfersUnreviewed})::int`,
          anyPartial: sql<boolean>`bool_or(${daily.coverageQuality} = 'partial' OR ${daily.holdingsStalePriced} > 0 OR coalesce(${daily.holdingsStaleAnchored}, 0) > 0 OR coalesce(${daily.holdingsBeforeRecords}, 0) > 0)`,
        })
        .from(daily)
        .innerJoin(schema.holdings, eq(schema.holdings.id, daily.scopeId))
        .innerJoin(schema.tokens, eq(schema.tokens.id, schema.holdings.tokenId))
        .where(this.includedHoldingRows(userId, baseCurrencyId, from, to))
        .groupBy(daily.snapshotDate)
        .orderBy(asc(daily.snapshotDate));
    } catch (error) {
      this.logger.error(
        { userId, baseCurrencyId, from, to, error: error instanceof Error ? error.message : error },
        'Failed to sum included holding-scope portfolio_value_daily rows per day'
      );
      throw error;
    }
  }

  // The inclusion contract over `scope_kind='holding'` rows: every reader that
  // adds per-holding rows up filters through this one clause, so a day's sum
  // and the rows it sums cannot disagree about which holdings count. A reader
  // asking for one holding's rows applies none. Assumes the `holdings` and
  // `tokens` joins.
  //
  // NOTE: the same predicate is TypeScript in `lib/holding-inclusion.ts`, which
  // the dashboard headline uses. The two must stay aligned, or the chart's
  // latest point stops reconciling with the headline.
  private includedHoldingRows(
    userId: string,
    baseCurrencyId: string,
    from: Date,
    to: Date,
    holdingIds?: readonly string[]
  ) {
    return and(
      eq(daily.userId, userId),
      eq(daily.scopeKind, 'holding'),
      eq(daily.baseCurrencyId, baseCurrencyId),
      gte(daily.snapshotDate, from.toISOString().slice(0, 10)),
      lte(daily.snapshotDate, to.toISOString().slice(0, 10)),
      includedInTotalSql(),
      ...(holdingIds ? [inArray(daily.scopeId, [...holdingIds])] : [])
    );
  }

  /**
   * The newest `limit` distinct days that carry a MEASUREMENT, under exactly
   * the inclusion contract `findIncludedHoldingScopeRange` applies (SC-1306).
   *
   * It exists so a caller can answer "is there a return to show here" without
   * reading the series it would be computed from. Home asks that on every load
   * — the Returns tab withdraws itself when the answer is no — and paying a
   * full TWR/XIRR/attribution run for one bit put a p50 of 4952ms in front of
   * the dashboard for every reader, including ones who never open the tab.
   *
   * `holdings_with_known_value > 0` is the same predicate `buildSeries` folds
   * on: a day where nothing in scope could be priced is dropped there rather
   * than plotted at zero, so counting it here would offer a tab with nothing
   * behind it.
   *
   * Newest-first and capped, so the planner walks the date index backwards and
   * stops. Two rows is all any caller has needed: see `ReturnsService.hasHistory`
   * for why that is the whole question and not an approximation of it.
   */
  async findLatestMeasuredDays(
    userId: string,
    baseCurrencyId: string,
    from: Date,
    to: Date,
    limit: number,
    transaction?: DatabaseTransaction,
    holdingIds?: readonly string[]
  ): Promise<string[]> {
    if (holdingIds !== undefined && holdingIds.length === 0) return [];
    if (limit <= 0) return [];
    try {
      const db = this.getDb(transaction);
      const includedHoldings = db
        .select({ id: schema.holdings.id })
        .from(schema.holdings)
        .innerJoin(schema.tokens, eq(schema.tokens.id, schema.holdings.tokenId))
        .where(
          and(
            eq(schema.holdings.userId, userId),
            includedInTotalSql(),
            ...(holdingIds ? [inArray(schema.holdings.id, [...holdingIds])] : [])
          )
        );
      const rows = await db
        .selectDistinct({ snapshotDate: schema.portfolioValueDaily.snapshotDate })
        .from(schema.portfolioValueDaily)
        .where(
          and(
            eq(schema.portfolioValueDaily.userId, userId),
            eq(schema.portfolioValueDaily.scopeKind, 'holding'),
            eq(schema.portfolioValueDaily.baseCurrencyId, baseCurrencyId),
            gte(schema.portfolioValueDaily.snapshotDate, from.toISOString().slice(0, 10)),
            lte(schema.portfolioValueDaily.snapshotDate, to.toISOString().slice(0, 10)),
            gt(schema.portfolioValueDaily.holdingsWithKnownValue, 0),
            sql`${schema.portfolioValueDaily.scopeId} = ANY(ARRAY(${includedHoldings}))`
          )
        )
        .orderBy(desc(schema.portfolioValueDaily.snapshotDate))
        .limit(limit);
      return rows.map((row) => String(row.snapshotDate).slice(0, 10));
    } catch (error) {
      this.logger.error(
        { userId, baseCurrencyId, from, to, error: error instanceof Error ? error.message : error },
        'Failed to read the latest measured portfolio_value_daily days'
      );
      throw error;
    }
  }

  // Latest `scope_kind='holding'` cost basis per holding for a user, in
  // the given base currency. Lets the holdings list / detail page show a
  // real gain/loss instead of the value=cost placeholder. One indexed
  // scan (idx_pvd_scope_user_date) with DISTINCT ON the newest snapshot.
  // Holdings with no rollup row, or a row predating the PnL columns
  // (cost_basis null), are simply absent from the map — the caller
  // falls back to current value.
  async findLatestHoldingCostBasis(
    userId: string,
    baseCurrencyId: string,
    transaction?: DatabaseTransaction
  ): Promise<Map<string, number>> {
    try {
      const db = this.getDb(transaction);
      const rows = await db
        .selectDistinctOn([schema.portfolioValueDaily.scopeId], {
          holdingId: schema.portfolioValueDaily.scopeId,
          costBasis: schema.portfolioValueDaily.costBasis,
        })
        .from(schema.portfolioValueDaily)
        .where(
          and(
            eq(schema.portfolioValueDaily.userId, userId),
            eq(schema.portfolioValueDaily.scopeKind, 'holding'),
            eq(schema.portfolioValueDaily.baseCurrencyId, baseCurrencyId)
          )
        )
        .orderBy(schema.portfolioValueDaily.scopeId, desc(schema.portfolioValueDaily.snapshotDate));
      const out = new Map<string, number>();
      for (const row of rows) {
        if (row.costBasis == null) continue;
        const n = Number(row.costBasis);
        if (Number.isFinite(n)) out.set(row.holdingId, n);
      }
      return out;
    } catch (error) {
      this.logger.error(
        { userId, baseCurrencyId, error: error instanceof Error ? error.message : error },
        'Failed to find latest holding cost basis'
      );
      throw error;
    }
  }

  // Fetch only the rows whose snapshot_date is in `dates`. Used by the
  // bucketed chart query: we compute bucket-end dates client-side, then
  // pull just those rows from the cache instead of loading every day in
  // the range and filtering in memory.
  async findByDates(
    userId: string,
    baseCurrencyId: string,
    dates: Date[],
    transaction?: DatabaseTransaction
  ): Promise<PortfolioValueDaily[]> {
    if (dates.length === 0) return [];
    try {
      const db = this.getDb(transaction);
      const dateStrs = dates.map((d) => d.toISOString().slice(0, 10));
      const results = await db
        .select()
        .from(schema.portfolioValueDaily)
        .where(
          and(
            eq(schema.portfolioValueDaily.userId, userId),
            eq(schema.portfolioValueDaily.baseCurrencyId, baseCurrencyId),
            inArray(schema.portfolioValueDaily.snapshotDate, dateStrs)
          )
        )
        .orderBy(asc(schema.portfolioValueDaily.snapshotDate));
      return results as PortfolioValueDaily[];
    } catch (error) {
      this.logger.error(
        {
          userId,
          baseCurrencyId,
          dateCount: dates.length,
          error: error instanceof Error ? error.message : error,
        },
        'Failed to find portfolio_value_daily by dates'
      );
      throw error;
    }
  }

  async findLatest(
    userId: string,
    baseCurrencyId: string,
    transaction?: DatabaseTransaction
  ): Promise<PortfolioValueDaily | null> {
    try {
      const db = this.getDb(transaction);
      const results = await db
        .select()
        .from(schema.portfolioValueDaily)
        .where(
          and(
            eq(schema.portfolioValueDaily.userId, userId),
            eq(schema.portfolioValueDaily.baseCurrencyId, baseCurrencyId)
          )
        )
        .orderBy(desc(schema.portfolioValueDaily.snapshotDate))
        .limit(1);
      return (results[0] as PortfolioValueDaily) ?? null;
    } catch (error) {
      this.logger.error(
        { userId, baseCurrencyId, error: error instanceof Error ? error.message : error },
        'Failed to find latest portfolio_value_daily'
      );
      throw error;
    }
  }

  // Most recent snapshot the rollup has *any* row for, regardless of
  // base currency. Used by the tx-import path to size `lookbackDays`
  // adaptively — most days, the gap is 0–1, so we don't recompute a
  // full year of history on every transaction-import.
  async findLatestSnapshotDate(
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<string | null> {
    try {
      const db = this.getDb(transaction);
      // Scope to 'user' rows so per-entity rollups (which are written
      // alongside the user-scope row in the same loop) don't shift
      // the latest-snapshot signal that the adaptive-lookback path
      // relies on.
      const results = await db
        .select({ snapshotDate: schema.portfolioValueDaily.snapshotDate })
        .from(schema.portfolioValueDaily)
        .where(
          and(
            eq(schema.portfolioValueDaily.userId, userId),
            eq(schema.portfolioValueDaily.scopeKind, 'user')
          )
        )
        .orderBy(desc(schema.portfolioValueDaily.snapshotDate))
        .limit(1);
      return results[0]?.snapshotDate ?? null;
    } catch (error) {
      this.logger.error(
        { userId, error: error instanceof Error ? error.message : error },
        'Failed to find latest portfolio_value_daily snapshot date'
      );
      throw error;
    }
  }

  // Every user with a stored user-scope day on or after `since` and a base
  // currency — the reach of a history recompute over that window (SC-1323).
  // No base currency means the rollup skips the user anyway.
  async findUserIdsWithHistorySince(
    since: Date,
    opts: { userId?: string } = {},
    transaction?: DatabaseTransaction
  ): Promise<string[]> {
    try {
      const db = this.getDb(transaction);
      const pvd = schema.portfolioValueDaily;
      const conditions = [
        eq(pvd.scopeKind, 'user'),
        gte(pvd.snapshotDate, since.toISOString().slice(0, 10)),
        isNotNull(schema.users.baseCurrencyId),
      ];
      if (opts.userId) conditions.push(eq(pvd.userId, opts.userId));
      const rows = await db
        .selectDistinct({ userId: pvd.userId })
        .from(pvd)
        .innerJoin(schema.users, eq(schema.users.id, pvd.userId))
        .where(and(...conditions))
        .orderBy(asc(pvd.userId));
      return rows.map((r) => r.userId);
    } catch (error) {
      this.logger.error(
        { since, opts, error: error instanceof Error ? error.message : error },
        'Failed to find users with stored portfolio history'
      );
      throw error;
    }
  }

  /**
   * How many days back a rebuild of this user's whole stored history has to
   * reach: to their earliest ledger row, balance reading or stored day, plus
   * two, and never fewer than `atLeastDays`.
   *
   * A failure is the caller's to handle and is not logged here: the api asks
   * on every holding and account mutation and carries on without an answer.
   */
  async findHistoryLookbackDays(
    userId: string,
    atLeastDays: number,
    transaction?: DatabaseTransaction
  ): Promise<number> {
    const [history] = await this.getDb(transaction).execute<{ days: number }>(sql`
      SELECT greatest(${atLeastDays}, coalesce(current_date - min(day)::date + 2, 0))::integer AS days FROM (
        SELECT occurred_at::date AS day FROM holding_transactions WHERE user_id = ${userId}
        UNION ALL SELECT observed_at::date FROM holding_balance_observations WHERE user_id = ${userId}
        UNION ALL SELECT snapshot_date FROM portfolio_value_daily WHERE user_id = ${userId}
      ) history
    `);
    return Number(history?.days ?? atLeastDays);
  }

  /** Null when the row already held these values, so nothing was written. */
  async upsert(
    row: NewPortfolioValueDaily,
    transaction?: DatabaseTransaction
  ): Promise<PortfolioValueDaily | null> {
    try {
      const db = this.getDb(transaction);
      const results = await db
        .insert(schema.portfolioValueDaily)
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle insert type constraint
        .values(row as any)
        .onConflictDoUpdate(ON_ROLLUP_CONFLICT)
        .returning();
      return (results[0] as PortfolioValueDaily | undefined) ?? null;
    } catch (error) {
      this.logger.error(
        { row, error: error instanceof Error ? error.message : error },
        'Failed to upsert portfolio_value_daily'
      );
      throw error;
    }
  }

  /** Returns only the rows written; an unchanged row is skipped. */
  async bulkUpsert(
    rows: NewPortfolioValueDaily[],
    transaction?: DatabaseTransaction
  ): Promise<PortfolioValueDaily[]> {
    try {
      if (rows.length === 0) return [];
      const db = this.getDb(transaction);
      const results = await db
        .insert(schema.portfolioValueDaily)
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle array insert type
        .values(rows as any[])
        .onConflictDoUpdate(ON_ROLLUP_CONFLICT)
        .returning();
      this.logger.debug({ count: results.length }, 'Bulk upserted portfolio_value_daily');
      return results as PortfolioValueDaily[];
    } catch (error) {
      this.logger.error(
        { count: rows.length, error: error instanceof Error ? error.message : error },
        'Failed to bulk upsert portfolio_value_daily'
      );
      throw error;
    }
  }

  // Drop all rollup rows for a user — used when re-computing from scratch.
  // Fast + safe because rollup is derived cache.
  async deleteForUser(
    userId: string,
    baseCurrencyId?: string,
    transaction?: DatabaseTransaction
  ): Promise<number> {
    try {
      const db = this.getDb(transaction);
      const conditions = [eq(schema.portfolioValueDaily.userId, userId)];
      if (baseCurrencyId) {
        conditions.push(eq(schema.portfolioValueDaily.baseCurrencyId, baseCurrencyId));
      }
      const results = await db
        .delete(schema.portfolioValueDaily)
        .where(and(...conditions))
        .returning({ userId: schema.portfolioValueDaily.userId });
      return results.length;
    } catch (error) {
      this.logger.error(
        { userId, baseCurrencyId, error: error instanceof Error ? error.message : error },
        'Failed to delete portfolio_value_daily for user'
      );
      throw error;
    }
  }
}
