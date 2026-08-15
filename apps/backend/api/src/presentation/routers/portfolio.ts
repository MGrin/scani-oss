/**
 * Portfolio history tRPC router.
 *
 * Exposes the historical-balance + PnL surface area to the frontend:
 *  - getNetWorthSeries: the daily-granularity chart data
 *  - getHoldingHistory: per-holding balance/value series (Phase 3)
 *
 * Reads `portfolio_value_daily` by default. Falls back to live
 * computation via PortfolioValuationAtTimeService for days not yet
 * rolled up (catches the "freshly connected, rollup hasn't run"
 * case cleanly).
 */

import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { PortfolioValueDailyRepository, UserJobRepository } from '@scani/domain/repositories';
import { HIDE_CLOSED_HOLDINGS_STALE_DAYS } from '@scani/domain/use-cases';
import { PORTFOLIO_HISTORY_BACKFILL, PORTFOLIO_HISTORY_LOOKBACK_DAYS } from '@scani/jobs';
import { BullMqEnqueueService } from '@scani/queue';
import { TRPCError } from '@trpc/server';
import Decimal from 'decimal.js';
import { and, eq, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { z } from 'zod';
import {
  type AggregatedDailyPoint,
  aggregateIncludedHoldingRows,
  hasKnownCoverage,
  type NetWorthHistoryRow,
  toAggregatedDaily,
  toNetWorthHistoryRow,
  unmeasuredDates,
  userNetWorthDaily,
} from '../../lib/net-worth-series';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

// Hard cap on chart span. 6 years matches the deepest realistic
// backfill (5y default in BackfillHistoricalPricesUseCase + headroom).
// Without this, an authenticated client can request a 2000-year span
// and tie up a backend process for hours in the per-day live-valuation
// loop below — a trivial self-DoS. The refine also rejects reversed
// ranges early instead of silently returning empty.
const MAX_NET_WORTH_SPAN_DAYS = 365 * 6;

// Granularity is purely a hint to the frontend axis-tick formatter
// now — the backend serves daily-resolution rows downsampled by LTTB
// so intra-week / intra-month spikes survive the trip. Range size
// just determines whether the x-axis labels read "Mar 8" vs "Mar
// 2026".
type Granularity = 'daily' | 'weekly' | 'monthly';

function pickGranularity(from: Date, to: Date): Granularity {
  const days = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
  if (days <= 90) return 'daily';
  if (days <= 730) return 'weekly';
  return 'monthly';
}

// Target points after downsampling. ~200 keeps recharts smooth on
// every range while preserving every meaningful peak/dip in the data.
// (For shorter ranges we'll have fewer source rows than the threshold,
// in which case LTTB returns the input unchanged.)
const LTTB_TARGET_POINTS = 200;

interface LttbPoint<T> {
  // Numeric x-axis (timestamp ms). Used for triangle-area math.
  x: number;
  y: number;
  // The raw row this point corresponds to; preserved so the
  // downsampled output keeps every original field (coverageQuality,
  // holdingsWithKnownValue, …).
  raw: T;
}

/**
 * Largest-Triangle-Three-Buckets downsampling. From Sveinn Steinarsson's
 * 2013 thesis, used by Grafana, TradingView, Highcharts, etc. — picks
 * `target` points from `data` such that the resulting line preserves
 * the visual shape (peaks + dips survive). O(n).
 *
 * When `data.length <= target` returns `data` unchanged; when `target
 * < 3` returns first+last only.
 */
function lttbDownsample<T>(data: LttbPoint<T>[], target: number): LttbPoint<T>[] {
  if (target >= data.length || target === 0) return data;
  if (target < 3) {
    const first = data[0];
    const last = data[data.length - 1];
    return first && last && first !== last ? [first, last] : first ? [first] : [];
  }

  const sampled: LttbPoint<T>[] = [];
  const every = (data.length - 2) / (target - 2);
  let aIdx = 0;
  const head = data[0];
  if (!head) return [];
  sampled.push(head);

  for (let i = 0; i < target - 2; i++) {
    // Mean point of the look-ahead bucket.
    let avgX = 0;
    let avgY = 0;
    const avgStart = Math.floor((i + 1) * every) + 1;
    const avgEnd = Math.min(Math.floor((i + 2) * every) + 1, data.length);
    const avgLen = avgEnd - avgStart;
    for (let j = avgStart; j < avgEnd; j++) {
      const p = data[j];
      if (!p) continue;
      avgX += p.x;
      avgY += p.y;
    }
    if (avgLen > 0) {
      avgX /= avgLen;
      avgY /= avgLen;
    }

    // Within the current bucket, pick the point that maximizes the
    // triangle area with `a` (last picked) and the avg of the next
    // bucket. That's what preserves the silhouette.
    const rangeStart = Math.floor(i * every) + 1;
    const rangeEnd = Math.floor((i + 1) * every) + 1;
    const a = data[aIdx];
    if (!a) continue;
    let maxArea = -1;
    let maxIdx = rangeStart;
    for (let j = rangeStart; j < rangeEnd; j++) {
      const p = data[j];
      if (!p) continue;
      const area = Math.abs((a.x - avgX) * (p.y - a.y) - (a.x - p.x) * (avgY - a.y)) * 0.5;
      if (area > maxArea) {
        maxArea = area;
        maxIdx = j;
      }
    }
    const picked = data[maxIdx];
    if (picked) {
      sampled.push(picked);
      aIdx = maxIdx;
    }
  }

  const tail = data[data.length - 1];
  if (tail) sampled.push(tail);
  return sampled;
}

const NetWorthSeriesInput = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
    baseCurrencyId: z.string().uuid().optional(),
    granularity: z.enum(['auto', 'daily', 'weekly', 'monthly']).default('auto'),
    // Optional per-entity scope. Omitted = user-wide (the existing
    // dashboard chart). The handler validates that the entity belongs
    // to the calling user before reading the per-scope rollup row.
    scope: z
      .object({
        kind: z.enum(['institution', 'account', 'holding']),
        id: z.string().uuid(),
      })
      .optional(),
    // `chart` downsamples to ~200 points so a six-year curve keeps its
    // silhouette without shipping 2,200 rows to a phone. `full` skips that
    // entirely, and exists for the export (SC-89): the file's whole claim is
    // "one row per day", and a spreadsheet built from LTTB-selected points
    // would have gaps a reader cannot see and would sum to the wrong thing.
    resolution: z.enum(['chart', 'full']).default('chart'),
  })
  .refine((v) => v.to.getTime() >= v.from.getTime(), {
    message: '`to` must be greater than or equal to `from`',
  })
  .refine(
    (v) => (v.to.getTime() - v.from.getTime()) / (24 * 60 * 60 * 1000) <= MAX_NET_WORTH_SPAN_DAYS,
    { message: `Date span must be ≤ ${MAX_NET_WORTH_SPAN_DAYS} days` }
  );

const HoldingHistoryInput = z
  .object({
    holdingId: z.string().uuid(),
    from: z.coerce.date(),
    to: z.coerce.date(),
  })
  .refine((v) => v.to.getTime() >= v.from.getTime(), {
    message: '`to` must be greater than or equal to `from`',
  })
  .refine(
    (v) => (v.to.getTime() - v.from.getTime()) / (24 * 60 * 60 * 1000) <= MAX_NET_WORTH_SPAN_DAYS,
    { message: `Date span must be ≤ ${MAX_NET_WORTH_SPAN_DAYS} days` }
  );

// Per-entity scope ownership check. Throws TRPCError NOT_FOUND when
// the entity doesn't exist or doesn't belong to `userId`. Returns
// silently when the scope is valid. Mirrors the pattern used by
// `getHoldingHistory` further down the file.
async function assertScopeOwnership(
  userId: string,
  scope: { kind: 'institution' | 'account' | 'holding'; id: string }
): Promise<void> {
  if (scope.kind === 'holding') {
    const row = await db
      .select({ id: schema.holdings.id })
      .from(schema.holdings)
      .where(and(eq(schema.holdings.id, scope.id), eq(schema.holdings.userId, userId)))
      .limit(1);
    if (!row[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Holding not found' });
    return;
  }
  if (scope.kind === 'account') {
    const row = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.id, scope.id), eq(schema.accounts.userId, userId)))
      .limit(1);
    if (!row[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Account not found' });
    return;
  }
  // institution: validated by membership — the user must own at least
  // one account in this institution. Stops a probe for institutions
  // the user has never added.
  const row = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.institutionId, scope.id), eq(schema.accounts.userId, userId)))
    .limit(1);
  if (!row[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Institution not found' });
}

export const portfolioRouter = router({
  getNetWorthSeries: protectedProcedure.input(NetWorthSeriesInput).query(async ({ ctx, input }) => {
    const { dbUser } = await requireAuth(ctx);
    const baseId = input.baseCurrencyId ?? dbUser.baseCurrencyId ?? null;
    if (!baseId) {
      // No configured base → can't render a chart meaningfully.
      // Return empty series so the UI shows a clear "set a base currency" CTA.
      return {
        series: [],
        baseCurrencyId: null,
        granularity: 'daily' as Granularity,
        unmeasuredDates: [] as string[],
      };
    }
    const dailyRepo = Container.get(PortfolioValueDailyRepository);

    // Granularity is now an axis-label hint only (Mar 8 vs Mar 2026);
    // data resolution is always daily and downsampled by LTTB so
    // intra-period spikes survive. Old behaviour bucketed bucket-end
    // dates (one Sunday per week, last day per month) which silently
    // hid mid-week deposits/withdrawals.
    const granularity: Granularity =
      input.granularity === 'auto' ? pickGranularity(input.from, input.to) : input.granularity;

    // Per-entity scope ownership guard. The detail-page charts
    // pass scope: { kind: 'institution' | 'account' | 'holding', id }
    // and the handler validates that entity belongs to the calling
    // user before reading the scoped rollup. Absent scope = user-wide.
    if (input.scope) {
      await assertScopeOwnership(dbUser.id, input.scope);
    }

    // Pure cache read — no live-fallback (see prior commit history;
    // live valuation OOM-killed the backend under chart click-spam).
    //
    // User-wide series sums the inclusion-filtered per-holding rollup
    // rows (hidden / inactive / scam holdings dropped) so the chart's
    // latest point reconciles with the dashboard headline. Scoped
    // detail-page series read the pre-aggregated per-entity row.
    const daily: AggregatedDailyPoint[] = input.scope
      ? (
          await dailyRepo.findRange(dbUser.id, baseId, input.from, input.to, undefined, input.scope)
        ).map(toAggregatedDaily)
      : // One definition of user-wide net worth, shared with the account export
        // — see `lib/net-worth-series.ts` for why (SC-98).
        await userNetWorthDaily(dbUser.id, baseId, input.from, input.to);

    // LTTB on the daily points. For ranges <= 200 days the threshold
    // is a no-op and we ship every daily row; for longer ranges the
    // algorithm picks the points that preserve the silhouette of the
    // curve (peaks + dips) so a spike on a single day doesn't get
    // averaged out by a weekly bucket.
    const points: LttbPoint<AggregatedDailyPoint>[] = daily.map((row) => ({
      x: new Date(row.snapshotDate).getTime(),
      y: Number(row.totalValue),
      raw: row,
    }));
    const sampled =
      input.resolution === 'full' ? points : lttbDownsample(points, LTTB_TARGET_POINTS);

    // Same row shape as the account workbook writes — see `NetWorthHistoryRow`.
    const series: NetWorthHistoryRow[] = sampled.map((p) => toNetWorthHistoryRow(p.raw));

    // What the series does NOT contain, said out loud (SC-115). A chart on a
    // category axis cannot tell a dropped day from a day that never was, and
    // the difference is whether the line it draws to the right edge is a
    // measurement or an interpolation. Never past today: a window that runs to
    // the end of the week is not missing Thursday.
    const today = new Date().toISOString().slice(0, 10);
    const requestedThrough = input.to.toISOString().slice(0, 10);
    const gaps = unmeasuredDates(
      daily.filter(hasKnownCoverage).map((row) => row.snapshotDate),
      requestedThrough < today ? requestedThrough : today
    );

    return { series, baseCurrencyId: baseId, granularity, unmeasuredDates: gaps };
  }),

  // PnL series: same shape as getNetWorthSeries plus cost_basis +
  // realized + unrealized columns. Reads the PnL columns added in
  // migration 0002 and populated by RollupPortfolioValueDailyUseCase
  // (which now calls PnLAtTimeService for each (scope, day) tuple).
  getPnLSeries: protectedProcedure.input(NetWorthSeriesInput).query(async ({ ctx, input }) => {
    const { dbUser } = await requireAuth(ctx);
    const baseId = input.baseCurrencyId ?? dbUser.baseCurrencyId ?? null;
    if (!baseId) {
      return { series: [], baseCurrencyId: null, granularity: 'daily' as Granularity };
    }
    const dailyRepo = Container.get(PortfolioValueDailyRepository);
    if (input.scope) {
      await assertScopeOwnership(dbUser.id, input.scope);
    }
    const granularity: Granularity =
      input.granularity === 'auto' ? pickGranularity(input.from, input.to) : input.granularity;

    // Same source split as getNetWorthSeries: user-wide sums the
    // inclusion-filtered per-holding rows; scoped reads the
    // pre-aggregated per-entity row.
    const daily: AggregatedDailyPoint[] = input.scope
      ? (
          await dailyRepo.findRange(dbUser.id, baseId, input.from, input.to, undefined, input.scope)
        ).map(toAggregatedDaily)
      : aggregateIncludedHoldingRows(
          await dailyRepo.findIncludedHoldingScopeRange(dbUser.id, baseId, input.from, input.to)
        );
    type PnLPoint = {
      date: string;
      totalValue: string;
      costBasis: string | null;
      realizedPnl: string | null;
      unrealizedPnl: string | null;
      totalPnl: string | null;
      coverageQuality: string;
      holdingsWithKnownValue: number;
      holdingsTotal: number;
      holdingsUnpriceable: number;
      /** See `AggregatedDailyPoint` — SC-151 and SC-149. A PnL figure whose
       *  cost side is partly unknown, or whose value side leans on prices
       *  older than the freshness window, is wrong in one direction only:
       *  upward. The counts are what let the chart say so. */
      holdingsStalePriced: number;
      holdingsBasisUnknown: number;
      /** The one that runs the other way (SC-160): outflows whose lots left
       *  with no gain booked because nobody has answered them, so this
       *  figure is short by whatever the real disposals among them were
       *  worth. Actionable, unlike the three above it — the review queue
       *  holds exactly these rows. */
      transfersUnreviewed: number;
    };
    const points: LttbPoint<AggregatedDailyPoint>[] = daily.map((row) => ({
      x: new Date(row.snapshotDate).getTime(),
      // Downsample on totalPnl when present, falling back to total
      // value (unpopulated rows from before the rollup re-runs).
      // Keeps the LTTB silhouette meaningful for either chart.
      y:
        row.realizedPnl != null && row.unrealizedPnl != null
          ? Number(row.realizedPnl) + Number(row.unrealizedPnl)
          : Number(row.totalValue),
      raw: row,
    }));
    const sampled = lttbDownsample(points, LTTB_TARGET_POINTS);
    const series: PnLPoint[] = sampled.map((p) => {
      const realized = p.raw.realizedPnl;
      const unrealized = p.raw.unrealizedPnl;
      const totalPnl =
        realized != null && unrealized != null
          ? new Decimal(realized).add(new Decimal(unrealized)).toString()
          : null;
      return {
        date: String(p.raw.snapshotDate).slice(0, 10),
        totalValue: p.raw.totalValue,
        costBasis: p.raw.costBasis ?? null,
        realizedPnl: realized ?? null,
        unrealizedPnl: unrealized ?? null,
        totalPnl,
        coverageQuality: p.raw.coverageQuality,
        holdingsWithKnownValue: p.raw.holdingsWithKnownValue,
        holdingsTotal: p.raw.holdingsTotal,
        holdingsUnpriceable: p.raw.holdingsUnpriceable,
        holdingsStalePriced: p.raw.holdingsStalePriced,
        holdingsBasisUnknown: p.raw.holdingsBasisUnknown,
        transfersUnreviewed: p.raw.transfersUnreviewed,
      };
    });
    return { series, baseCurrencyId: baseId, granularity };
  }),

  // Phase-3 surface: per-holding balance-over-time. Kept in the router
  // from the start so the frontend can code against a stable endpoint
  // shape as Phase 3 lands cost basis + sparkline.
  getHoldingHistory: protectedProcedure.input(HoldingHistoryInput).query(async ({ ctx, input }) => {
    const { dbUser } = await requireAuth(ctx);
    // Ownership guard — verify the holding belongs to the caller so the
    // endpoint can't become an IDOR.
    const holdingRow = await db
      .select({ id: schema.holdings.id })
      .from(schema.holdings)
      .where(and(eq(schema.holdings.id, input.holdingId), eq(schema.holdings.userId, dbUser.id)))
      .limit(1);
    if (!holdingRow[0]) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Holding not found' });
    }
    const baseId = dbUser.baseCurrencyId ?? null;
    if (!baseId) {
      return { holdingId: input.holdingId, series: [] as Array<{ date: string; value: number }> };
    }
    // Per-day value series for the holding — reads the
    // `scope_kind='holding'` rollup rows the rollup already produces.
    const rows = await Container.get(PortfolioValueDailyRepository).findRange(
      dbUser.id,
      baseId,
      input.from,
      input.to,
      undefined,
      { kind: 'holding', id: input.holdingId }
    );
    const points: LttbPoint<(typeof rows)[number]>[] = rows.map((row) => ({
      x: new Date(String(row.snapshotDate)).getTime(),
      y: Number(row.totalValue),
      raw: row,
    }));
    const sampled = lttbDownsample(points, LTTB_TARGET_POINTS);
    const series = sampled.map((p) => ({
      date: String(p.raw.snapshotDate).slice(0, 10),
      value: Number(p.raw.totalValue),
    }));
    return { holdingId: input.holdingId, series };
  }),

  // Manual trigger for the portfolio-history-backfill job — same job
  // the nightly cron runs, but on demand. Wired up to a "Recompute
  // portfolio history" button in Settings so users can rebuild the
  // chart cache after import / data fixes without waiting for 04:00
  // UTC. Passes PORTFOLIO_HISTORY_LOOKBACK_DAYS so a single click
  // rebuilds the whole window the charts can show — it must exceed the
  // 1Y chart range or the chart's oldest point reads a stale row. If a
  // backfill is already in flight for this user we return that jobId
  // instead of stacking duplicates — each run is heavy (16K+ provider
  // lookups) and the worker advisory lock would skip the duplicate.
  recomputeHistory: protectedProcedure.mutation(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    const userJobs = Container.get(UserJobRepository);
    const inFlight = await userJobs.findInFlightByName(dbUser.id, PORTFOLIO_HISTORY_BACKFILL.name);
    if (inFlight) {
      return { jobId: inFlight.jobId, deduplicated: true } as const;
    }
    const jobId = await Container.get(BullMqEnqueueService).add(PORTFOLIO_HISTORY_BACKFILL, {
      userId: dbUser.id,
      requestId: randomUUID(),
      tokenIds: [],
      lookbackDays: PORTFOLIO_HISTORY_LOOKBACK_DAYS,
    });
    return { jobId, deduplicated: false } as const;
  }),

  // Snapshot of every data-quality counter the user-facing system
  // currently degrades on. Counts are scoped to the user's holdings,
  // tokens are global (one user in prod). The Settings page renders
  // this as a sanity card so duplicates / unpriced holdings / negative
  // openings show up before they break the chart, instead of after.
  getDataQualityReport: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    const userId = dbUser.id;

    const dupRows = (await db.execute<{ symbol: string; n: number }>(sql`
      SELECT symbol, COUNT(*)::int AS n FROM tokens
      GROUP BY symbol HAVING COUNT(*) > 1 ORDER BY n DESC, symbol
    `)) as unknown as Array<{ symbol: string; n: number }>;

    const staleInterval = sql.raw(`'${HIDE_CLOSED_HOLDINGS_STALE_DAYS} days'`);
    // The previous version had a correlated `MAX(occurred_at) FROM
    // holding_transactions WHERE holding_id = h.id` subquery in the
    // stale_zero branch, executed once per qualifying row. For users
    // with thousands of zero-balance holdings this dominated the
    // query's runtime.
    //
    // Pre-aggregate `last_tx_at` per holding via LEFT JOIN +
    // GROUP BY in a CTE, then derive every count from the joined
    // CTE in a single SELECT with COUNT(*) FILTER (WHERE ...). One
    // pass over user holdings + one pass over their transactions,
    // independent of holding count.
    const countsRows = (await db.execute<{
      total: number;
      visible: number;
      zero_visible: number;
      stale_zero: number;
      unpriced_visible: number;
      negative_opening: number;
      no_coverage: number;
    }>(sql`
      WITH user_h AS (
        SELECT id, token_id, balance::numeric AS balance_n, is_hidden, is_active
        FROM holdings
        WHERE user_id = ${userId}
      ),
      h_last_tx AS (
        SELECT h.id AS holding_id, MAX(t.occurred_at) AS last_tx_at
        FROM user_h h
        LEFT JOIN holding_transactions t ON t.holding_id = h.id
        GROUP BY h.id
      ),
      h_coverage AS (
        SELECT h.id AS holding_id,
               c.opening_balance_quantity::numeric AS opening_balance_n,
               (c.holding_id IS NOT NULL) AS has_coverage
        FROM user_h h
        LEFT JOIN holding_coverage c ON c.holding_id = h.id
      ),
      h_priced AS (
        SELECT h.id AS holding_id,
               EXISTS (
                 SELECT 1 FROM token_prices p
                 WHERE p.token_id = h.token_id
                   AND p.timestamp > NOW() - INTERVAL '7 days'
               ) AS is_priced,
               -- The same behavioural predicate the coverage denominator
               -- uses (SC-146): never quoted once, and still in an
               -- unpriceable cooldown. Split out of unpriced_visible
               -- because an airdrop token with no market is not a defect
               -- in our pricing, and warning about it forever trains the
               -- reader to ignore the panel.
               EXISTS (
                 SELECT 1 FROM tokens t
                 WHERE t.id = h.token_id
                   AND t.unpriceable_until IS NOT NULL
                   AND t.unpriceable_until > NOW()
                   AND NOT EXISTS (
                     SELECT 1 FROM token_prices p2 WHERE p2.token_id = t.id
                   )
               ) AS is_unpriceable
        FROM user_h h
      )
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE h.is_hidden = false AND h.is_active = true)::int AS visible,
        COUNT(*) FILTER (WHERE h.is_hidden = false AND h.balance_n = 0)::int AS zero_visible,
        COUNT(*) FILTER (
          WHERE h.is_hidden = false
            AND h.balance_n = 0
            AND COALESCE(lt.last_tx_at, '1970-01-01'::timestamptz)
                < NOW() - INTERVAL ${staleInterval}
        )::int AS stale_zero,
        COUNT(*) FILTER (
          WHERE h.is_hidden = false
            AND h.balance_n > 0
            AND p.is_priced = false
            AND p.is_unpriceable = false
        )::int AS unpriced_visible,
        COUNT(*) FILTER (
          WHERE h.is_hidden = false
            AND h.balance_n > 0
            AND p.is_unpriceable = true
        )::int AS unpriceable_visible,
        COUNT(*) FILTER (
          WHERE c.opening_balance_n < 0
        )::int AS negative_opening,
        COUNT(*) FILTER (
          WHERE c.has_coverage = false
        )::int AS no_coverage
      FROM user_h h
      LEFT JOIN h_last_tx lt ON lt.holding_id = h.id
      LEFT JOIN h_coverage c ON c.holding_id = h.id
      LEFT JOIN h_priced p ON p.holding_id = h.id
    `)) as unknown as Array<{
      total: number;
      visible: number;
      zero_visible: number;
      stale_zero: number;
      unpriced_visible: number;
      unpriceable_visible: number;
      negative_opening: number;
      no_coverage: number;
    }>;

    const counts = countsRows[0] ?? {
      total: 0,
      visible: 0,
      zero_visible: 0,
      stale_zero: 0,
      unpriced_visible: 0,
      unpriceable_visible: 0,
      negative_opening: 0,
      no_coverage: 0,
    };

    return {
      duplicateTokens: dupRows.map((r) => ({ symbol: r.symbol, count: r.n })),
      holdings: {
        total: counts.total,
        visible: counts.visible,
        zeroVisible: counts.zero_visible,
        zeroVisibleStale: counts.stale_zero,
        unpricedVisible: counts.unpriced_visible,
        unpriceableVisible: counts.unpriceable_visible,
        negativeOpening: counts.negative_opening,
        missingCoverage: counts.no_coverage,
      },
      thresholds: {
        staleClosedDays: HIDE_CLOSED_HOLDINGS_STALE_DAYS,
      },
    };
  }),
});
