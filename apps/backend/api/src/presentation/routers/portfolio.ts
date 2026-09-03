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
import { SCAM_PROBABILITY_THRESHOLD } from '@scani/domain/lib/constants';
import { PortfolioValueDailyRepository, UserJobRepository } from '@scani/domain/repositories';
import { PeriodDisposalsService, type ReturnsScope, ReturnsService } from '@scani/domain/services';
import { HIDE_CLOSED_HOLDINGS_STALE_DAYS } from '@scani/domain/use-cases';
import { PORTFOLIO_HISTORY_BACKFILL, PORTFOLIO_HISTORY_LOOKBACK_DAYS } from '@scani/jobs';
import { BullMqEnqueueService } from '@scani/queue';
import { type PeriodDisposals, parseCostBasisMethod, toDisposalLotMatchDto } from '@scani/shared';
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
import { withoutPeriodSeries } from '../../lib/returns-response';
import { strictInput } from '../lib/strict-input';
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

/**
 * A half-open window of disposals, `[from, to)` (SC-90).
 *
 * `to` is EXCLUSIVE and strictly greater than `from`, which is the one place
 * this differs from every other window input in this file. Two reasons, both
 * about a reading a caller cannot check:
 *
 * - Half-open so adjacent windows partition disposals. An inclusive upper
 *   bound counts a midnight disposal in both, and somebody adding two periods
 *   together gets a number with no error to notice.
 * - Strictly greater so `to === from` is a REFUSAL rather than an empty
 *   result. A zero-width window returns zero rows over a portfolio that may
 *   have hundreds, and an empty answer to a malformed question is
 *   indistinguishable from an empty answer to a good one.
 */
const DisposalWindowInput = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
  })
  .refine((v) => v.to.getTime() > v.from.getTime(), {
    message: '`to` must be strictly greater than `from` — the window is half-open, [from, to)',
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

/**
 * TWR + XIRR over a window, at any level the product has a page for (SC-457).
 *
 * The scope is optional and absent means the whole portfolio, matching
 * `getNetWorthSeries` above so the two are asked the same way. Ownership is
 * NOT checked here: `ReturnsScopeResolver` resolves a scope that is not this
 * user's to `null`, so a foreign id produces the same NOT_FOUND as one that
 * does not exist — one gate, in the layer that knows what a scope is.
 */
const ReturnsInput = z.object({
  baseCurrencyId: z.string().uuid().optional(),
  scope: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('holding'), id: z.string().uuid() }),
      z.object({ kind: z.literal('account'), id: z.string().uuid() }),
      z.object({ kind: z.literal('institution'), id: z.string().uuid() }),
      z.object({ kind: z.literal('group'), id: z.string().uuid() }),
      z.object({ kind: z.literal('vault'), id: z.string().uuid() }),
    ])
    .optional(),
  window: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('ytd') }),
      z.object({ kind: z.literal('1y') }),
      z.object({ kind: z.literal('all') }),
      z.object({
        kind: z.literal('custom'),
        from: z.coerce.date(),
        to: z.coerce.date(),
      }),
    ])
    .default({ kind: 'all' }),
  /**
   * Whether the per-sub-period breakdowns cross the wire — the TWR chain's,
   * and the FX attribution's over the same boundaries.
   *
   * They are always COMPUTED — `TwrResult.periods` is the boundary set SC-458
   * attributes FX over and SC-464 chains a benchmark across, and losing it
   * would cost those tickets a re-derivation they cannot do from the scalar.
   * What they do not have to do is reach a browser that only prints two
   * numbers. Measured on an account with real history, `periods` is very
   * nearly the whole of an `all` response — sent on every call, for nothing on
   * screen (SC-471).
   *
   * One flag for both, because they share their boundaries: a client given
   * one series and not the other could not line them up. Off by default, and
   * ABSENT rather than empty when off — `[]` would say the window had no
   * sub-periods, which is a different and false statement. The counts beside
   * them still travel, so a client can tell how many there were without
   * carrying them.
   */
  includePeriods: z.boolean().default(false),
});

export const portfolioRouter = router({
  // The performance surface. Reads the same rollup rows the chart above
  // plots, so a return can never disagree with the curve it is printed under.
  getReturns: protectedProcedure.input(strictInput(ReturnsInput)).query(async ({ ctx, input }) => {
    const { dbUser } = await requireAuth(ctx);

    if (input.window.kind === 'custom') {
      const span =
        (input.window.to.getTime() - input.window.from.getTime()) / (24 * 60 * 60 * 1000);
      if (span < 0 || span > MAX_NET_WORTH_SPAN_DAYS) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Custom window must be between 0 and ${MAX_NET_WORTH_SPAN_DAYS} days`,
        });
      }
    }

    const scope: ReturnsScope = input.scope ?? { kind: 'user' };
    // The base currency is resolved by the SERVICE, not here (SC-457 review).
    // This handler used to do it, which meant the only caller that could not
    // reach the query without one was this one — and every script, job and
    // test that called `compute` directly passed `undefined` straight into a
    // primary-key column.
    const outcome = await Container.get(ReturnsService).compute({
      userId: dbUser.id,
      baseCurrencyId: input.baseCurrencyId,
      scope,
      window: input.window,
    });

    // Same shape `getNetWorthSeries` uses for the "set a base currency" CTA:
    // an account with none has no rollup rows either, so there is nothing to
    // show and nothing has gone wrong.
    if (outcome.status === 'no-base-currency') return { returns: null, baseCurrencyId: null };
    if (outcome.status === 'scope-not-found') {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Scope not found' });
    }
    const returns = input.includePeriods ? outcome.returns : withoutPeriodSeries(outcome.returns);
    return { returns, baseCurrencyId: outcome.returns.baseCurrencyId };
  }),

  getNetWorthSeries: protectedProcedure
    .input(strictInput(NetWorthSeriesInput))
    .query(async ({ ctx, input }) => {
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
            await dailyRepo.findRange(
              dbUser.id,
              baseId,
              input.from,
              input.to,
              undefined,
              input.scope
            )
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
  getPnLSeries: protectedProcedure
    .input(strictInput(NetWorthSeriesInput))
    .query(async ({ ctx, input }) => {
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
            await dailyRepo.findRange(
              dbUser.id,
              baseId,
              input.from,
              input.to,
              undefined,
              input.scope
            )
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
  /**
   * Every disposal across the portfolio in a window of time (SC-90).
   *
   * The wider sibling of `holdings.realizedLedger`, which answers the same
   * question for one holding. It exists because "why did my realized gain move
   * this year" is not answerable by asking that question once per holding: a
   * coin bought on an exchange and sold from a wallet belongs to a transfer
   * component, and `forComponentsOf` is what walks those on one shared lot
   * ledger rather than resetting the cost at the transfer.
   *
   * **Not tax output.** See `docs/technical/2026-08-14_why-no-tax-statement.md`
   * and the note on the `period-disposals` contract. The window is two instants
   * on purpose — the route encodes no jurisdiction's idea of a year.
   *
   * No ownership guard is needed and none would help: the service takes a
   * `userId` and sources its holding set from `findIdsForUser`, so the caller
   * has no way to name a holding at all. Contrast `realizedLedger`, which does
   * take a holding id and therefore does carry one.
   *
   * **The method is the account's stored one and cannot be overridden per
   * request (SC-957).** This input carried an optional `costBasisMethod` that
   * won over `users.cost_basis_method`, so a caller could be handed realized
   * figures computed under a rule the user never selected and that nothing
   * anywhere recorded. mgrin's 2026-09-03 decision is that the method stays
   * freely changeable *with a recorded history* — and an override defeats that
   * by construction, because the method it computes under is never stored, so
   * no history row can explain the figure it produced.
   *
   * It was removed rather than recorded because it had no caller to serve:
   * `git grep getDisposals` returned exactly one line, this definition, and
   * `costBasisMethod` appeared in no frontend file. `strictInput` (SC-675) means
   * a client that sends it now gets a refusal rather than being quietly ignored,
   * so the removal cannot fail silently either.
   */
  getDisposals: protectedProcedure
    .input(strictInput(DisposalWindowInput))
    .query(async ({ ctx, input }): Promise<PeriodDisposals> => {
      const { dbUser } = await requireAuth(ctx);
      const baseCurrencyId = dbUser.baseCurrencyId ?? null;
      const method = parseCostBasisMethod(dbUser.costBasisMethod);
      const empty = {
        periodStart: input.from.toISOString(),
        periodEnd: input.to.toISOString(),
        costBasisMethod: method,
        rows: [],
        rowCount: 0,
        byOutcome: {
          realized: 0,
          unpriced: 0,
          unreviewed: 0,
          retained: 0,
          awaiting_pair: 0,
        },
        byBasisQuality: { known: 0, partial: 0, unknown: 0 },
        totals: { proceeds: '0', costBasis: '0', gain: '0' },
      };
      if (!baseCurrencyId) {
        // Every figure here is denominated in the base currency, so without
        // one there is no ledger to report — not an empty one. Same refusal
        // `realizedLedger` makes, and for the same reason.
        return { ...empty, baseCurrencyId: null };
      }

      const result = await Container.get(PeriodDisposalsService).forPeriod(
        dbUser.id,
        baseCurrencyId,
        { from: input.from, to: input.to },
        method
      );

      return {
        periodStart: input.from.toISOString(),
        periodEnd: input.to.toISOString(),
        baseCurrencyId,
        costBasisMethod: result.method,
        rows: result.rows.map(toDisposalLotMatchDto),
        rowCount: result.rows.length,
        byOutcome: result.byOutcome,
        byBasisQuality: result.byBasisQuality,
        totals: {
          proceeds: result.totals.proceeds.toString(),
          costBasis: result.totals.costBasis.toString(),
          gain: result.totals.gain.toString(),
        },
      };
    }),

  getHoldingHistory: protectedProcedure
    .input(strictInput(HoldingHistoryInput))
    .query(async ({ ctx, input }) => {
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

  /**
   * Every data-quality counter the user-facing system degrades on, and — for
   * the ones a reader can act on — **the holdings each counter counted**.
   *
   * The ids are the whole point (SC-293). SC-268 found that every flagged row
   * on the Settings panel said "Look into this" while none of them was a
   * control, and could not become one because the payload identified nothing
   * to link to. A row can only send a reader somewhere if the server can name
   * the set behind its number, so each actionable counter now returns that set
   * and the count is `ids.length` rather than a second, separately-computed
   * figure that can drift from it.
   *
   * **`shown` is the scope, and it is the scope the Holdings list uses.** Not
   * hidden, and under the scam threshold — exactly `findByUserWithFullDetails`
   * with its defaults, which is what `holdings.getWithDetails` feeds the list
   * from. The counters used to filter on `is_hidden` alone (and the two
   * coverage ones on nothing at all), so a scam-flagged or hidden holding
   * could be counted here and be unreachable on every screen: the row would
   * say 16 and the list it links to would show 15. Scoping the count to the
   * set the destination can show is what makes the number and the list agree
   * by construction rather than by review.
   *
   * The `symbol` counters are counted in POSITIONS for the same reason. Three
   * rows used to count distinct symbols while their labels said "positions",
   * so "2" sat above a link that would have opened five rows.
   */
  getDataQualityReport: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    const userId = dbUser.id;

    const staleInterval = sql.raw(`'${HIDE_CLOSED_HOLDINGS_STALE_DAYS} days'`);
    const scamThreshold = sql.raw(String(SCAM_PROBABILITY_THRESHOLD));

    /**
     * One row per holding the reader can actually see, carrying every fact the
     * counters below are derived from.
     *
     * Per-holding rather than pre-aggregated because the ids are now part of
     * the answer: an aggregate cannot say *which* holdings it counted, and
     * computing the counts in one query and the ids in another is the drift
     * this endpoint exists to remove. The row count is the size of the
     * reader's holdings list — the same set `holdings.getWithDetails` already
     * returns in full, with far more columns, on every visit to that screen.
     *
     * The pre-aggregation the previous version needed is still here where it
     * mattered: `h_last_tx` groups the transaction join once rather than
     * running a correlated `MAX(occurred_at)` per qualifying row.
     */
    const shownRows = (await db.execute<{
      id: string;
      symbol: string;
      lookalike_of: string | null;
      segment: string | null;
      is_zero: boolean;
      is_positive: boolean;
      is_stale_zero: boolean;
      is_priced: boolean;
      is_unpriceable: boolean;
      has_price_source: boolean;
      is_fiat: boolean;
      dup_symbol: boolean;
      opening_negative: boolean;
      has_coverage: boolean;
    }>(sql`
      WITH shown AS (
        SELECT h.id, h.token_id, h.balance::numeric AS balance_n,
               t.symbol, t.lookalike_of, t.market_segment, t.provider_metadata,
               t.unpriceable_until, tt.code AS type_code
        FROM holdings h
        JOIN tokens t ON t.id = h.token_id
        JOIN token_types tt ON tt.id = t.type_id
        WHERE h.user_id = ${userId}
          AND h.is_hidden = false
          AND t.is_scam_probability < ${scamThreshold}
      ),
      -- A symbol the reader holds under more than one TOKEN row. The
      -- catalogue-wide version of this counted every duplicate symbol in
      -- tokens, most of which the reader has never held: 11 in production
      -- against 3 they actually hold, and no link could have reconciled the
      -- two. A duplicate that fragments nobody's position is a catalogue
      -- fact, and the catalogue is not this screen.
      dup AS (
        SELECT symbol FROM shown GROUP BY symbol HAVING COUNT(DISTINCT token_id) > 1
      ),
      last_tx AS (
        SELECT s.id AS holding_id, MAX(t.occurred_at) AS last_tx_at
        FROM shown s LEFT JOIN holding_transactions t ON t.holding_id = s.id
        GROUP BY s.id
      )
      SELECT
        s.id,
        s.symbol,
        s.lookalike_of,
        s.market_segment AS segment,
        (s.balance_n = 0) AS is_zero,
        (s.balance_n > 0) AS is_positive,
        (s.balance_n = 0
          AND COALESCE(lt.last_tx_at, '1970-01-01'::timestamptz)
              < NOW() - INTERVAL ${staleInterval}) AS is_stale_zero,
        EXISTS (
          SELECT 1 FROM token_prices p
          WHERE p.token_id = s.token_id AND p.timestamp > NOW() - INTERVAL '7 days'
        ) AS is_priced,
        -- Never quoted once, and still inside an unpriceable cooldown — the
        -- same behavioural predicate the chart's coverage denominator uses
        -- (SC-146). Split out because an airdrop token with no market is not
        -- a defect in our pricing.
        (s.unpriceable_until IS NOT NULL
          AND s.unpriceable_until > NOW()
          AND NOT EXISTS (SELECT 1 FROM token_prices p2 WHERE p2.token_id = s.token_id)
        ) AS is_unpriceable,
        -- A provider id PricingProviderRouter.groupTokensByProvider can
        -- route on (SC-217). Rows whose provider_metadata is a JSON-encoded
        -- STRING rather than an object are treated as having one: the jsonb
        -- ? operator cannot see into them, and reporting legacy
        -- serialisation as a pricing fault is a false positive.
        (jsonb_typeof(s.provider_metadata) <> 'object'
          OR (s.provider_metadata -> 'coingecko' ? 'id')
          OR (s.provider_metadata ? 'coinGeckoId')
          OR (s.provider_metadata -> 'finnhub' ? 'symbol')
          OR (s.provider_metadata -> 'etherscan' ? 'contractAddress')
          OR (s.provider_metadata -> 'solana' ? 'mint')
        ) AS has_price_source,
        (s.type_code = 'fiat') AS is_fiat,
        (s.symbol IN (SELECT symbol FROM dup)) AS dup_symbol,
        (c.opening_balance_quantity::numeric < 0) AS opening_negative,
        (c.holding_id IS NOT NULL) AS has_coverage
      FROM shown s
      LEFT JOIN last_tx lt ON lt.holding_id = s.id
      LEFT JOIN holding_coverage c ON c.holding_id = s.id
    `)) as unknown as Array<{
      id: string;
      symbol: string;
      lookalike_of: string | null;
      segment: string | null;
      is_zero: boolean;
      is_positive: boolean;
      is_stale_zero: boolean;
      is_priced: boolean;
      is_unpriceable: boolean;
      has_price_source: boolean;
      is_fiat: boolean;
      dup_symbol: boolean;
      opening_negative: boolean;
      has_coverage: boolean;
    }>;

    // `total` describes the reader's whole holdings table rather than the
    // shown set — it is the second half of "76 shown, 81 in total", and
    // answering it from `shown` would make it say "76 of 76" forever.
    //
    // The first half is NOT asked here. It used to be, as
    // `is_hidden = false AND is_active = true`, and that is a different set
    // from the one the holdings list renders: the list keeps inactive rows and
    // badges them, so on any account with a closed position the row understated
    // the list it names (SC-388). `shown` is the list's own set — not hidden,
    // under the scam threshold — and every other counter on this panel already
    // reads it.
    const totalsRows = (await db.execute<{ total: number }>(sql`
      SELECT COUNT(*)::int AS total FROM holdings WHERE user_id = ${userId}
    `)) as unknown as Array<{ total: number }>;
    const totals = totalsRows[0] ?? { total: 0 };

    const idsWhere = (predicate: (row: (typeof shownRows)[number]) => boolean): string[] =>
      shownRows.filter(predicate).map((row) => row.id);

    // A position whose price is silent, split by whose fault the silence is
    // (SC-217). `noPriceSource` is NOT a subset of `noRecentPrice`: a token
    // carrying no provider id is never quoted, so it earns an unpriceable
    // cooldown and leaves the row above — which is exactly the case that hid
    // both TRUMP rows for three months.
    const unpriced = (row: (typeof shownRows)[number]) =>
      row.is_positive && !row.is_priced && !row.is_unpriceable;
    const noSource = (row: (typeof shownRows)[number]) =>
      row.is_positive && !row.is_fiat && !row.has_price_source && !row.is_priced;

    const flagged = {
      duplicateSymbol: idsWhere((row) => row.dup_symbol),
      lookalike: idsWhere((row) => row.lookalike_of !== null),
      zeroBalance: idsWhere((row) => row.is_zero),
      noRecentPrice: idsWhere(unpriced),
      noPriceSource: idsWhere(noSource),
      negativeOpening: idsWhere((row) => row.opening_negative),
      noCoverage: idsWhere((row) => !row.has_coverage),
    } as const;

    /**
     * The distinct symbols behind a flagged set, each carrying how many of the
     * reader's positions it accounts for.
     *
     * `count` is POSITIONS, so a row's chips sum to the row's own number —
     * `USDC×7, DOG×2, WETH×3` under a figure of 12. The catalogue version
     * counted token rows under a figure that counted symbols, and the two had
     * no arithmetic relationship at all.
     */
    const symbolsOf = (predicate: (row: (typeof shownRows)[number]) => boolean) => {
      const seen = new Map<
        string,
        { symbol: string; count: number; lookalikeOf: string | null; segment: string | null }
      >();
      for (const row of shownRows) {
        if (!predicate(row)) continue;
        const entry = seen.get(row.symbol);
        if (entry) entry.count += 1;
        else
          seen.set(row.symbol, {
            symbol: row.symbol,
            count: 1,
            lookalikeOf: row.lookalike_of,
            segment: row.segment,
          });
      }
      // Lookalikes first, so the entry that needs a second look is read first.
      return [...seen.values()].sort(
        (a, b) =>
          Number(b.lookalikeOf !== null) - Number(a.lookalikeOf !== null) ||
          b.count - a.count ||
          a.symbol.localeCompare(b.symbol)
      );
    };

    return {
      /**
       * The identity of each flagged set — holding ids, in the reader's own
       * holdings. A row links to `/holdings?quality=<key>` and the list
       * narrows to exactly these.
       */
      flagged,
      duplicateTokens: symbolsOf((row) => row.dup_symbol).map((entry) => ({
        symbol: entry.symbol,
        count: entry.count,
        lookalikeOf: entry.lookalikeOf,
      })),
      lookalikeTokens: symbolsOf((row) => row.lookalike_of !== null).map((entry) => ({
        symbol: entry.symbol,
        lookalikeOf: entry.lookalikeOf ?? '',
      })),
      unroutableTokens: symbolsOf(noSource).map((entry) => ({
        symbol: entry.symbol,
        segment: entry.segment,
      })),
      holdings: {
        total: totals.total,
        visible: shownRows.length,
        // Derived from the id arrays rather than counted a second time: the
        // number a row shows and the list it opens cannot disagree if there
        // is only one of them.
        zeroVisible: flagged.zeroBalance.length,
        zeroVisibleStale: shownRows.filter((row) => row.is_stale_zero).length,
        unpricedVisible: flagged.noRecentPrice.length,
        unpriceableVisible: shownRows.filter((row) => row.is_positive && row.is_unpriceable).length,
        negativeOpening: flagged.negativeOpening.length,
        missingCoverage: flagged.noCoverage.length,
      },
      thresholds: {
        staleClosedDays: HIDE_CLOSED_HOLDINGS_STALE_DAYS,
      },
    };
  }),
});
