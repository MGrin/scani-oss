import { HISTORY_REBUILD_JOB_NAME } from '@scani/shared';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { flowRoleOf } from '../../lib/returns/flow-classification';
import { type CoverageFacts, flowCoverageOf } from '../../lib/returns/flow-coverage';
import {
  type AttributionPoint,
  attributeCurrencyEffect,
  type CurrencyBucket,
  type ReturnAttribution,
} from '../../lib/returns/fx-attribution';
import { materialStartIndex } from '../../lib/returns/material-start';
import { computeTimeWeightedReturn, type TwrResult } from '../../lib/returns/twr';
import {
  type ResolvedReturnWindow,
  type ReturnWindowRequest,
  resolveReturnWindow,
} from '../../lib/returns/window';
import { type Cashflow, type XirrResult, xirr } from '../../lib/returns/xirr';
import { HoldingCoverageRepository } from '../../repositories/HoldingCoverageRepository';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { PortfolioValueDailyRepository } from '../../repositories/PortfolioValueDailyRepository';
import { UserJobRepository } from '../../repositories/UserJobRepository';
import { UserRepository } from '../../repositories/UserRepository';
import { PriceGraphService } from '../pricing/PriceGraphService';
import { AssetCurrencyService } from './AssetCurrencyService';
import {
  type ExternalFlow,
  ExternalFlowService,
  type FlowProblem,
  netFlowByDate,
} from './ExternalFlowService';
import {
  type ReturnsScope,
  ReturnsScopeResolver,
  type WeightedHolding,
} from './ReturnsScopeResolver';

/**
 * How a portfolio PERFORMED, as opposed to what it is worth (SC-457).
 *
 * Scani could say what everything is worth and could not say whether any of it
 * was a good idea. Every figure on every screen was a value or a delta between
 * two values, and a delta cannot tell a deposit from a gain — a portfolio that
 * received 50,000 last month reads as up 50,000, which is the one number
 * nobody wants.
 *
 * Two answers ship together because they answer different questions and each
 * is misleading alone:
 *
 *   * **TWR** removes the timing of contributions. It is how the ASSETS did,
 *     and it is what a fund quotes, because the manager did not choose when
 *     the money arrived.
 *   * **XIRR** puts the timing back in. It is how the OWNER did, and it is
 *     lower than TWR for anyone who bought the top and higher for anyone who
 *     bought the dip.
 *
 * ## Where the inputs come from
 *
 * Nothing new is computed or stored. The value series is
 * `portfolio_value_daily` at `scope_kind = 'holding'`, filtered by the
 * inclusion contract in SQL — the same rows the home chart plots, so a return
 * cannot disagree with the curve it is printed under. The flows are
 * `holding_transactions`, classified and valued by `ExternalFlowService`.
 *
 * That inheritance carries the rollup's known limits with it, and they are
 * real: the nightly job recomputes only the last 30 days, so a ledger
 * correction older than that does not reach the series until something
 * re-runs with a wider lookback. A returns figure is exactly as current as the
 * chart above it.
 *
 * ## What it deliberately does not do
 *
 * It never sums realized PnL. A return here is derived from values and flows
 * only, so the trap that has already produced one wrong figure —
 * `RealizedLedgerService.forHolding` returns one holding's SLICE of a transfer
 * component, and summing a representative is arbitrary rather than
 * approximate (SC-379) — cannot arise. Anyone adding a realized breakdown to
 * this surface later must go through `forComponentsOf`.
 *
 * Everything is base currency, converted once at the point each flow is
 * valued, never listed per currency (SC-60). A return figure that mixes
 * currencies is worse than none, and a second FX path is what that ticket
 * exists to prevent.
 *
 * ## Splitting the asset return from the FX return (SC-458)
 *
 * `attribution` answers the question the base-currency figure above it cannot:
 * how much of a return was earned and how much was the exchange rate. It is
 * chained over exactly the sub-period boundaries `twr` produced — which is
 * what `TwrResult.periods` was preserved for — and it composes
 * MULTIPLICATIVELY, `(1+asset)(1+currency) = 1+base`. See
 * `lib/returns/fx-attribution.ts` for why that rule and not the additive one.
 *
 * It costs one extra query for the currency identities, one price prefetch,
 * and nothing at all for a scope held entirely in the base currency — the
 * common case, where the split is exactly "all asset, no currency" and no rate
 * has to be read to know it.
 */

const ANCHOR_LOOKBACK_DAYS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReturnsRequest {
  userId: string;
  /**
   * Optional override. When absent, `users.base_currency_id` is read — the
   * SAME column `RollupPortfolioValueDailyUseCase` reads to decide what
   * currency it wrote each `portfolio_value_daily` row in. Asking in a
   * currency the rollup never wrote returns an empty series, not a converted
   * one, because `base_currency_id` is part of that table's primary key.
   *
   * It became optional after review (SC-457): as a required `string` it was
   * still `undefined` at runtime for any caller outside the tRPC router, and
   * `undefined` does not fail as a missing base currency — postgres.js
   * refuses the whole statement with UNDEFINED_VALUE and the error names a
   * 1,400-character query rather than the missing field. Reproduced against
   * the local dev database on 2026-08-19, identically on `ytd`, `1y` and
   * `all`. Resolving it here means there is no way to ask the question
   * without one.
   */
  baseCurrencyId?: string;
  scope: ReturnsScope;
  window: ReturnWindowRequest;
  /** Injected so a YTD window is testable. Defaults to now. */
  now?: Date;
}

/**
 * Three outcomes, named, because two of them are not results and used to be
 * expressed the same way.
 *
 * `compute` returned `ReturnsResult | null` before review, where `null` meant
 * "scope not found" — leaving no way at all to say "this account has no base
 * currency", which is a real state (`users.base_currency_id` is nullable, and
 * the nightly rollup SKIPS those users, so such an account has no rows to
 * measure either). A caller could only learn it by watching a query throw.
 *
 * A silent default would be worse than a throw. `BaseCurrencyProvider` on the
 * frontend defaulted to USD when it was mounted below the tree that needed it
 * and rendered every figure in the wrong currency with nothing on screen
 * saying so (SC-36). A return figure is a percentage, so the same mistake here
 * would not even look wrong.
 */
export type ReturnsOutcome =
  | { status: 'ok'; returns: ReturnsResult }
  /** The scope does not exist, or does not belong to this user. */
  | { status: 'scope-not-found' }
  /** No `baseCurrencyId` given and the account has none set. */
  | { status: 'no-base-currency' };

export interface ReturnsCoverage {
  /** Days inside the effective window that carry a measurement. */
  measuredDays: number;
  /** Calendar days the effective window spans. */
  windowDays: number;
  /** Of `measuredDays`, how many were not `coverage_quality = 'full'`. */
  daysNotFullyCovered: number;
  /** Sub-periods whose opening value was zero, so no return could be taken. */
  skippedPeriods: number;
  /** External flows nothing could value — see `ExternalFlowSeries`. */
  unvaluedFlows: number;
  /** External flows valued from a price beyond the staleness cap. */
  staleValuedFlows: number;
  /** Flows after the last measured day, with no sub-period to belong to. */
  flowsAfterLastMeasuredDay: number;
}

export interface ReturnsResult {
  scope: ReturnsScope;
  baseCurrencyId: string;
  /** What was asked for. */
  requestedWindow: { kind: string; from: string; to: string };
  /**
   * What was actually measured: the first and last MEASURED days. Always
   * reported, because it is routinely narrower than the request — an account
   * opened in March has no January, and `'all'` has no start until the series
   * supplies one.
   */
  effectiveWindow: { from: string; to: string } | null;
  startValue: string | null;
  endValue: string | null;
  /** Sum of every external flow inside the effective window, base currency. */
  netExternalFlow: string;
  /**
   * The measured days themselves, so a caller can chart the window it was
   * just given a single number for (SC-1297). Same points the TWR chained
   * over — a second valuation path is what SC-60 exists to prevent.
   */
  series: { date: string; value: string; netExternalFlow: string }[];
  /** `null` when fewer than two days were measured — an absence, not a zero. */
  twr: TwrResult | null;
  /**
   * The same window's return split into what the assets did and what the
   * exchange rate did (SC-458). `null` when there was nothing to split — no
   * chain to attribute over, or not one sub-period whose currencies could all
   * be priced at both boundaries.
   *
   * An absence, never a zero: "0% of this was currency" and "we could not tell
   * how much of this was currency" are opposite claims, and the second one is
   * the one a reader must not be shown as the first.
   */
  attribution: ReturnAttribution | null;
  xirr: XirrResult;
  coverage: ReturnsCoverage;
  eligibility: { eligible: boolean; reasons: string[] };
  /**
   * Set when the figures cover only part of the scope: the holdings whose
   * data could not support a return are left out and named, rather than
   * withholding every other holding's return for them (SC-1421). `null` when
   * the whole scope is measured, or when nothing is shown.
   */
  subset: ReturnsSubset | null;
}

export interface ReturnsSubset {
  /** Holdings the figures are computed over. */
  includedHoldings: number;
  /** Holdings with a measured value in the window, included or not. */
  measuredHoldings: number;
  /** One entry per reason; a holding with two reasons counts under both. */
  excluded: { reason: string; holdings: number }[];
  /** The left-out holdings' value on the last measured day, base currency. */
  excludedValue: string;
  /**
   * Counted holdings that were held before their statement starts, so they
   * enter the figure on its first day as money put in (SC-1427). A reader
   * should know a position's earlier gain is not in the return.
   */
  enteredLate: number;
  /**
   * Counted holdings no source priced on any day of the window, counted at
   * zero: zero value and zero flows, so they move no figure (SC-1428).
   */
  unpricedAtZero: number;
}

@Service()
export class ReturnsService {
  private readonly holdingCoverage = Container.get(HoldingCoverageRepository);
  private readonly scopeResolver = Container.get(ReturnsScopeResolver);
  private readonly flowService = Container.get(ExternalFlowService);
  private readonly dailyRepository = Container.get(PortfolioValueDailyRepository);
  private readonly userJobs = Container.get(UserJobRepository);
  private readonly userRepository = Container.get(UserRepository);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly assetCurrencyService = Container.get(AssetCurrencyService);
  private readonly priceGraphService = Container.get(PriceGraphService);

  async compute(request: ReturnsRequest): Promise<ReturnsOutcome> {
    const now = request.now ?? new Date();
    const window = resolveReturnWindow(request.window, now);

    // Before any query. A blank string counts as absent: it reaches the
    // driver as a legal parameter and matches no row, so it would answer
    // "you have no history" to a question that was never asked properly.
    const requested = request.baseCurrencyId?.trim();
    const baseCurrencyId =
      requested && requested.length > 0
        ? requested
        : ((await this.userRepository.findById(request.userId))?.baseCurrencyId ?? null);
    if (!baseCurrencyId) return { status: 'no-base-currency' };

    const holdings = await this.scopeResolver.resolve(request.userId, request.scope);
    if (holdings === null) return { status: 'scope-not-found' };

    // Reach back past the window's own start for an OPENING ANCHOR: the last
    // measured day strictly before it. Without one, the first day inside the
    // window would have to serve as both the opening value and the first
    // measurement, and every flow that landed on it would be invisible —
    // counted into the opening value and never subtracted from a return.
    //
    // A far-back anchor is not a problem: the first sub-period simply spans
    // the gap, and the flows counted for it span exactly the same gap, so the
    // arithmetic stays right and only the reported `effectiveWindow` widens.
    const anchorFrom = new Date(window.from.getTime() - ANCHOR_LOOKBACK_DAYS * DAY_MS);
    const [rows, currencyByHolding] = await Promise.all([
      this.dailyRepository.findIncludedHoldingValueRange(
        request.userId,
        baseCurrencyId,
        anchorFrom,
        window.to,
        request.scope.kind === 'user' ? undefined : holdings.map((h) => h.holdingId)
      ),
      // Which currency each holding's own price is set in, so the value series
      // can be split by currency as it is folded rather than re-walked after.
      this.currencyByHolding(holdings.map((h) => h.holdingId)),
    ]);

    const weights = new Map(holdings.map((h) => [h.holdingId, h.weight]));
    const fullPoints = selectWindowPoints(buildSeries(rows, weights, currencyByHolding), window);

    const requestedWindow = {
      kind: window.kind,
      from: window.from.toISOString().slice(0, 10),
      to: window.to.toISOString().slice(0, 10),
    };

    if (fullPoints.length === 0) {
      return {
        status: 'ok',
        returns: {
          scope: request.scope,
          baseCurrencyId,
          requestedWindow,
          effectiveWindow: null,
          startValue: null,
          endValue: null,
          netExternalFlow: '0',
          series: [],
          twr: null,
          attribution: null,
          xirr: { status: 'undefined', reason: 'too-few-flows' },
          coverage: emptyCoverage(window),
          eligibility: { eligible: false, reasons: ['insufficient-history'] },
          subset: null,
        },
      };
    }

    const fullFirst = fullPoints[0] as SeriesPoint;
    const fullLast = fullPoints[fullPoints.length - 1] as SeriesPoint;

    // Only holdings that actually appear in the value series can contribute
    // flows. A holding with transactions but no rollup row is absent from the
    // value side too, and booking its flows against a value that never moved
    // would be a pure fabrication.
    const measuredHoldingIds = new Set(rows.map((row) => row.holdingId));
    const measured = holdings.filter((h) => measuredHoldingIds.has(h.holdingId));

    const [scan, coverageByHolding, rebuilding, rebuildNegative, unchangedSince] =
      await Promise.all([
        this.flowService.forHoldings(
          measured,
          baseCurrencyId,
          endOfDay(fullFirst.date),
          endOfDay(fullLast.date)
        ),
        this.holdingCoverage.findManyByHoldingIds(measured.map((h) => h.holdingId)),
        // An edit queues a full-history recompute; until it has run, the rollup
        // rows still describe the ledger before the edit. Reading the job rather
        // than comparing timestamps is what lets this clear: the post-import
        // rollup only rewrites recent days, so a timestamp check stayed on for
        // most accounts (SC-1396, measured on production).
        this.userJobs.findInFlightByName(request.userId, HISTORY_REBUILD_JOB_NAME),
        this.holdingCoverage.findRebuildGoesNegative(measured.map((h) => h.holdingId)),
        this.holdingCoverage.findUnchangedSinceFirstReading(measured.map((h) => h.holdingId)),
      ]);

    // Eligibility is decided per HOLDING and the scope's figure is taken over
    // the holdings that pass (SC-1421). Deciding it for the scope as a whole
    // withheld mgrin's entire portfolio on production: 115 of 122 holdings
    // carried at least one reason, most of them holdings with no value in the
    // window at all, so any real portfolio read as unmeasurable.
    // Only the days the series measured: a day nothing could be priced on is
    // dropped from it, so a holding's row on that day never reaches a figure.
    const measuredDays = new Set(fullPoints.map((point) => point.date));
    const windowRows = rows.filter((row) =>
      measuredDays.has(String(row.snapshotDate).slice(0, 10))
    );
    const zeroed = neverPriced(windowRows);
    const reasonsByHolding = holdingReasons(
      measured,
      windowRows,
      coverageByHolding,
      scan.problemsByHolding,
      zeroed,
      rebuildNegative,
      unchangedSince
    );
    const included = measured.filter((h) => !reasonsByHolding.has(h.holdingId));
    const partial = included.length > 0 && included.length < measured.length;
    const unpricedAtZero = included.filter((h) => zeroed.has(h.holdingId)).length;

    let points = fullPoints;
    let measuredRows = rows;
    let flowScan = scan;
    if (partial || unpricedAtZero > 0) {
      const keep = new Set(included.map((h) => h.holdingId));
      // Counted at zero, so its unpriced days are not a gap in the figure.
      measuredRows = rows
        .filter((row) => keep.has(row.holdingId))
        .map((row) =>
          zeroed.has(row.holdingId) ? { ...row, totalValue: '0', coverageQuality: 'full' } : row
        );
      points = selectWindowPoints(buildSeries(measuredRows, weights, currencyByHolding), window);
      const narrowed = points[0]?.date !== fullFirst.date || points.at(-1)?.date !== fullLast.date;
      flowScan =
        points.length > 0 && narrowed
          ? await this.flowService.forHoldings(
              included,
              baseCurrencyId,
              endOfDay((points[0] as SeriesPoint).date),
              endOfDay((points[points.length - 1] as SeriesPoint).date)
            )
          : { ...scan, flows: scan.flows.filter((flow) => keep.has(flow.holdingId)) };
    }
    if (points.length === 0) points = fullPoints;

    const measure = (series: readonly SeriesPoint[], scanned: readonly ExternalFlow[]) => {
      const first = series[0] as SeriesPoint;
      const measuredDates = series.map((point) => point.date);
      const allFlows = [
        ...scanned,
        ...arrivalFlows(measuredRows, weights, scanned, measuredDates.slice(1), first.date),
      ];
      const folded = netFlowByDate(allFlows, measuredDates.slice(1), currencyByHolding);
      const valuationPoints = series.map((point, index) => ({
        date: point.date,
        value: point.value,
        netExternalFlow:
          index === 0 ? new Decimal(0) : (folded.byDate.get(point.date) ?? new Decimal(0)),
      }));
      return {
        allFlows,
        ...folded,
        valuationPoints,
        twr: computeTimeWeightedReturn(valuationPoints),
      };
    };

    let flows = flowScan.flows;
    let measurement = measure(points, flows);
    // A window whose opening capital is a sliver of today's value is decided
    // by that sliver, so it starts where the capital becomes material, and
    // `effectiveWindow` says since when (SC-1439).
    const materialFrom = measurement.twr
      ? materialStartIndex(measurement.valuationPoints, measurement.twr.periods)
      : 0;
    if (materialFrom > 0) {
      points = points.slice(materialFrom);
      const opensAt = endOfDay((points[0] as SeriesPoint).date);
      flows = flows.filter((flow) => flow.occurredAt > opensAt);
      measurement = measure(points, flows);
    }
    const { allFlows, byDateAndCurrency, unattributed, valuationPoints, twr } = measurement;

    const first = points[0] as SeriesPoint;
    const last = points[points.length - 1] as SeriesPoint;
    const rebuilt = partial || unpricedAtZero > 0 || materialFrom > 0;
    const unvaluedCount = rebuilt
      ? flows.filter((flow) => flow.valuationBasis === null && !zeroed.has(flow.holdingId)).length
      : flowScan.unvaluedCount;
    const staleValuedCount = rebuilt
      ? flows.filter((flow) => flow.stale).length
      : flowScan.staleValuedCount;
    const attribution = attributeCurrencyEffect(
      await this.attributionPoints(points, byDateAndCurrency, baseCurrencyId, window.to)
    );
    const netExternalFlow = valuationPoints.reduce(
      (sum, point) => sum.add(point.netExternalFlow),
      new Decimal(0)
    );

    // What is left after the per-holding split is about the scope's own
    // series, and only one thing about it withholds: no sub-period that could
    // be measured, where there is no return to take. Three things that used to are
    // reported instead (SC-1421). A window that starts before the history
    // does is measured from where it starts (`effectiveWindow`, which is what
    // `since` says). A sub-period that opened at zero is skipped by the chain
    // and counted in `coverage.skippedPeriods`, which is how an account that
    // started empty begins. A flow after the last measured day is a cashflow
    // to XIRR and outside every TWR sub-period; `flowsAfterLastMeasuredDay`
    // carries it.
    // Held before a statement that starts inside the window: its first value is
    // booked as money put in by `arrivalFlows`, like any mid-window purchase,
    // and the reader is told its earlier gain is not in the figure (SC-1427).
    const enteredLate = included.filter(({ holdingId }) => {
      const coverage = flowCoverageOf(
        coverageByHolding.get(holdingId),
        unchangedSince.get(holdingId)
      );
      return coverage.kind === 'from' && coverage.heldBefore && coverage.from > first.date;
    }).length;

    const reasons: string[] = [];
    if (rebuilding) reasons.push('rebuilding-history');
    if (included.length === 0) {
      for (const set of reasonsByHolding.values()) reasons.push(...set);
    }
    if (points.length < 2 || (twr?.measuredPeriods ?? 0) === 0) {
      reasons.push('insufficient-history');
    }
    const eligibility = { eligible: reasons.length === 0, reasons: [...new Set(reasons)] };

    return {
      status: 'ok',
      returns: {
        scope: request.scope,
        baseCurrencyId,
        requestedWindow,
        effectiveWindow: { from: first.date, to: last.date },
        startValue: first.value.toString(),
        endValue: last.value.toString(),
        netExternalFlow: netExternalFlow.toString(),
        series: valuationPoints.map((point) => ({
          date: point.date,
          value: point.value.toString(),
          netExternalFlow: point.netExternalFlow.toString(),
        })),
        eligibility,
        twr: eligibility.eligible ? twr : null,
        attribution: eligibility.eligible ? attribution : null,
        xirr: eligibility.eligible
          ? xirr(toCashflows(first, last, allFlows, unattributed))
          : { status: 'undefined', reason: 'ineligible' },
        coverage: {
          measuredDays: points.length,
          windowDays:
            Math.round(
              (Date.parse(`${last.date}T00:00:00Z`) - Date.parse(`${first.date}T00:00:00Z`)) /
                DAY_MS
            ) + 1,
          daysNotFullyCovered: points.filter((point) => point.coverageQuality !== 'full').length,
          skippedPeriods: twr?.skippedPeriods ?? 0,
          unvaluedFlows: unvaluedCount,
          staleValuedFlows: staleValuedCount,
          flowsAfterLastMeasuredDay: unattributed.length,
        },
        subset:
          eligibility.eligible && (partial || enteredLate > 0 || unpricedAtZero > 0)
            ? {
                ...subsetOf(
                  included.length,
                  measured,
                  reasonsByHolding,
                  rows,
                  weights,
                  fullLast.date
                ),
                enteredLate,
                unpricedAtZero,
              }
            : null,
      },
    };
  }

  /**
   * Whether this scope has a return to show at all — the one bit Home needs,
   * without the run that produces the figure (SC-1306).
   *
   * Home asks it on EVERY load, because the Returns tab withdraws itself when
   * the answer is no, and until this existed the only way to ask was `compute`.
   * That put a p50 of 4952ms in front of the dashboard for every reader,
   * including the ones who never open the tab.
   *
   * ## It is the same question, not an approximation of it
   *
   * `returnsView` shows money exactly when `compute` produced a `twr`, and
   * `computeTimeWeightedReturn` is `null` below two points. `selectWindowPoints`
   * builds those points as the measured days INSIDE the window plus, at most,
   * the last measured day strictly before it. So two points exist exactly when
   * the two newest measured days in `[anchorFrom, window.to]` include one at or
   * after `window.from`:
   *
   *   - both inside  -> two points inside
   *   - newest inside, second older -> one point plus its anchor
   *   - newest older than the window -> nothing inside, so no points at all
   *
   * which is why the read is `ORDER BY snapshot_date DESC LIMIT 2` and why
   * ONE row, or two whose newest predates the window, is a no.
   *
   * A scope with one measured day and enough flows for an XIRR is the one case
   * this answers `false` about where `compute` would have a figure. It is a
   * deliberate direction: a withheld tab is recoverable on the next load, and
   * `useHomeChart` hands the decision back to `getReturns` the moment the tab
   * is open, so nothing is permanently hidden by it.
   */
  async hasHistory(
    request: Omit<ReturnsRequest, 'baseCurrencyId'> & { baseCurrencyId?: string }
  ): Promise<boolean> {
    const now = request.now ?? new Date();
    const window = resolveReturnWindow(request.window, now);

    const requested = request.baseCurrencyId?.trim();
    const baseCurrencyId =
      requested && requested.length > 0
        ? requested
        : ((await this.userRepository.findById(request.userId))?.baseCurrencyId ?? null);
    if (!baseCurrencyId) return false;

    // A user-wide scope is every holding, so the contract in SQL already says
    // so and there is nothing to resolve. Anything narrower has to be resolved
    // and owned before it can be asked about — the same check `compute` makes.
    let holdingIds: string[] | undefined;
    if (request.scope.kind !== 'user') {
      const holdings = await this.scopeResolver.resolve(request.userId, request.scope);
      if (holdings === null) return false;
      holdingIds = holdings.map((h) => h.holdingId);
    }

    const anchorFrom = new Date(window.from.getTime() - ANCHOR_LOOKBACK_DAYS * DAY_MS);
    const days = await this.dailyRepository.findLatestMeasuredDays(
      request.userId,
      baseCurrencyId,
      anchorFrom,
      window.to,
      2,
      undefined,
      holdingIds
    );
    if (days.length < 2) return false;
    return (days[0] as string) >= window.from.toISOString().slice(0, 10);
  }

  /**
   * `holdingId -> currency token id`, `null` where nothing could place the
   * asset. One `holdings` read and two inside `AssetCurrencyService`, for any
   * number of holdings.
   */
  private async currencyByHolding(
    holdingIds: readonly string[]
  ): Promise<Map<string, string | null>> {
    const byHolding = new Map<string, string | null>();
    if (holdingIds.length === 0) return byHolding;
    const holdingRows = await this.holdingRepository.findByIds([...holdingIds]);
    const currencyByToken = await this.assetCurrencyService.resolve(
      holdingRows.map((row) => row.tokenId)
    );
    for (const row of holdingRows) {
      byHolding.set(row.id, currencyByToken.get(row.tokenId) ?? null);
    }
    return byHolding;
  }

  /**
   * The measured series re-shaped for `attributeCurrencyEffect`: every point
   * carrying every currency the window touched, each with the day's rate into
   * base.
   *
   * The rate work is bounded by ONE prefetch, whatever the window's length,
   * and since SC-1306 that prefetch is bounded in TIME as well as in count.
   * That is not an optimisation — SC-471 is a ticket about this exact request
   * spending 51 of its 53 seconds on sequential `token_prices` reads, and a
   * rate per currency per day would have been 1,470 more of them on the
   * account that produced the measurement. Every conversion below reads the
   * in-memory index; a currency that IS the base needs no read at all, which
   * is why a single-currency portfolio pays nothing for this.
   */
  private async attributionPoints(
    points: readonly SeriesPoint[],
    flowsByDate: ReadonlyMap<string, Map<string | null, Decimal>>,
    baseCurrencyId: string,
    until: Date
  ): Promise<AttributionPoint[]> {
    const currencies = new Set<string | null>();
    for (const point of points) for (const key of point.byCurrency.keys()) currencies.add(key);
    for (const bucket of flowsByDate.values()) for (const key of bucket.keys()) currencies.add(key);

    const rates = await this.fxRates(
      [...currencies].filter((id): id is string => id !== null && id !== baseCurrencyId),
      baseCurrencyId,
      points.map((point) => point.date),
      until
    );

    const rateOf = (currencyTokenId: string | null, date: string): Decimal | null => {
      if (currencyTokenId === null) return null;
      if (currencyTokenId === baseCurrencyId) return ONE;
      return rates.get(currencyTokenId)?.get(date) ?? null;
    };

    const ordered = [...currencies];
    return points.map((point) => ({
      date: point.date,
      buckets: ordered.map(
        (currencyTokenId): CurrencyBucket => ({
          currencyTokenId,
          value: point.byCurrency.get(currencyTokenId) ?? new Decimal(0),
          rate: rateOf(currencyTokenId, point.date),
        })
      ),
      flowByCurrency: flowsByDate.get(point.date) ?? new Map<string | null, Decimal>(),
    }));
  }

  /** `currency token id -> date -> units of base per unit of currency`. */
  private async fxRates(
    currencyTokenIds: readonly string[],
    baseCurrencyId: string,
    dates: readonly string[],
    until: Date
  ): Promise<Map<string, Map<string, Decimal | null>>> {
    const rates = new Map<string, Map<string, Decimal | null>>();
    if (currencyTokenIds.length === 0) return rates;

    // Bounded to the START of the earliest day this will be asked about
    // (SC-1306). Every conversion below happens at `<date>T23:59:59.999Z`, so
    // a bound at the earliest date's midnight sits strictly before the
    // earliest ask — which is what the repository's carry-in row needs in
    // order to answer identically to the unbounded fetch.
    const earliest = dates.length > 0 ? dates.reduce((a, b) => (a < b ? a : b)) : null;
    const priceLookup = await this.priceGraphService.buildPriceLookup(
      currencyTokenIds,
      baseCurrencyId,
      until,
      undefined,
      earliest ? new Date(`${earliest}T00:00:00.000Z`) : undefined
    );

    for (const currencyTokenId of currencyTokenIds) {
      const byDate = new Map<string, Decimal | null>();
      for (const date of dates) {
        const conversion = await this.priceGraphService.convert(
          ONE,
          currencyTokenId,
          baseCurrencyId,
          new Date(`${date}T23:59:59.999Z`),
          { preferGranularity: 'daily', priceLookup, tx: undefined }
        );
        // A pair with no rate stays `null` all the way to the attribution,
        // which drops the sub-period rather than reading the gap as a
        // currency that did not move. That substitution is the defect SC-471
        // found one layer down, in the same code path.
        byDate.set(date, conversion ? conversion.rate : null);
      }
      rates.set(currencyTokenId, byDate);
    }
    return rates;
  }
}

const ONE = new Decimal(1);
const ZERO = new Decimal(0);

function endOfDay(date: string): Date {
  return new Date(`${date}T23:59:59.999Z`);
}

type HoldingRow = {
  holdingId: string;
  snapshotDate: string;
  coverageQuality: string;
  holdingsTotal: number;
  holdingsStalePriced: number;
  holdingsStaleAnchored?: number | null;
  holdingsBeforeRecords?: number | null;
  holdingsInterpolated?: number | null;
  transfersUnreviewed: number;
};

/**
 * Holdings no source priced on any day of the window (SC-1428). Unpriced on
 * every day it held something, and on at least one such day: a holding priced
 * even once is a gap in known data, which zero would misstate.
 */
function neverPriced(
  windowRows: ReadonlyArray<{
    holdingId: string;
    holdingsTotal: number;
    holdingsWithKnownValue: number;
  }>
): Set<string> {
  const priced = new Set<string>();
  const held = new Set<string>();
  for (const row of windowRows) {
    if (row.holdingsTotal === 0) continue;
    held.add(row.holdingId);
    if (row.holdingsWithKnownValue > 0) priced.add(row.holdingId);
  }
  return new Set([...held].filter((id) => !priced.has(id)));
}

/**
 * Why each holding cannot support a return, for the holdings that cannot.
 * A holding absent from the result is measurable. Every reason here is a fact
 * about ONE holding's data; the reasons about the scope's own series are
 * decided after the measurable ones are summed (SC-1421).
 */
function holdingReasons(
  measured: readonly WeightedHolding[],
  windowRows: readonly HoldingRow[],
  coverageByHolding: ReadonlyMap<string, CoverageFacts>,
  problemsByHolding: ReadonlyMap<string, ReadonlySet<FlowProblem>>,
  zeroed: ReadonlySet<string>,
  rebuildNegative: ReadonlySet<string>,
  unchangedSince: ReadonlyMap<string, string>
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (holdingId: string, reason: string) => {
    const set = out.get(holdingId) ?? new Set<string>();
    set.add(reason);
    out.set(holdingId, set);
  };
  for (const { holdingId } of measured) {
    const coverage = coverageByHolding.get(holdingId);
    if (flowCoverageOf(coverage, unchangedSince.get(holdingId)).kind === 'incomplete') {
      add(holdingId, 'incomplete-flow-coverage');
    }
    // A ledger that cannot reach its own earliest balance is missing outflows,
    // whatever its coverage claims (SC-1444).
    if (rebuildNegative.has(holdingId)) add(holdingId, 'incomplete-flow-coverage');
    const residual = coverage?.unexplainedResidual;
    if (residual != null && !new Decimal(residual).isZero()) add(holdingId, 'unresolved-change');
    const problems = problemsByHolding.get(holdingId);
    if (problems?.has('unresolved')) add(holdingId, 'unresolved-change');
    if (problems?.has('unvalued') && !zeroed.has(holdingId)) add(holdingId, 'missing-valuation');
    if (problems?.has('stale')) add(holdingId, 'stale-valuation');
  }
  const interpolatedDates = new Map<string, string[]>();
  for (const row of windowRows) {
    // A day before the holding's first record counts nothing for it (SC-1323).
    if (row.holdingsTotal === 0) continue;
    if (row.coverageQuality !== 'full' && !zeroed.has(row.holdingId))
      add(row.holdingId, 'missing-valuation');
    if (row.holdingsStalePriced > 0 || (row.holdingsStaleAnchored ?? 0) > 0)
      add(row.holdingId, 'stale-valuation');
    if ((row.holdingsBeforeRecords ?? 0) > 0) add(row.holdingId, 'insufficient-history');
    if ((row.holdingsInterpolated ?? 0) > 0) {
      const dates = interpolatedDates.get(row.holdingId) ?? [];
      dates.push(String(row.snapshotDate).slice(0, 10));
      interpolatedDates.set(row.holdingId, dates);
    }
    if (row.transfersUnreviewed > 0) add(row.holdingId, 'unresolved-change');
  }
  // A short run of interpolated days is a gap between two observations, not
  // missing history: tolerated up to three consecutive days. Longer, the line
  // between the observations IS the data, and it excludes (SC-1427).
  for (const [holdingId, dates] of interpolatedDates) {
    if (longestConsecutiveRun(dates) > MAX_INTERPOLATED_RUN_DAYS)
      add(holdingId, 'insufficient-history');
  }
  return out;
}

const MAX_INTERPOLATED_RUN_DAYS = 3;

function longestConsecutiveRun(dates: readonly string[]): number {
  const days = [...new Set(dates)]
    .map((d) => Date.parse(`${d}T00:00:00Z`) / DAY_MS)
    .sort((a, b) => a - b);
  let longest = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i > 0 && days[i] === (days[i - 1] as number) + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  return longest;
}

function subsetOf(
  includedHoldings: number,
  measured: readonly WeightedHolding[],
  reasonsByHolding: ReadonlyMap<string, ReadonlySet<string>>,
  rows: ReadonlyArray<{ snapshotDate: string; holdingId: string; totalValue: string }>,
  weights: ReadonlyMap<string, Decimal>,
  lastDate: string
): Omit<ReturnsSubset, 'enteredLate' | 'unpricedAtZero'> {
  const counts = new Map<string, number>();
  for (const set of reasonsByHolding.values()) {
    for (const reason of set) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  let excludedValue = new Decimal(0);
  for (const row of rows) {
    if (String(row.snapshotDate).slice(0, 10) !== lastDate) continue;
    if (!reasonsByHolding.has(row.holdingId)) continue;
    excludedValue = excludedValue.add(
      new Decimal(row.totalValue).mul(weights.get(row.holdingId) ?? 0)
    );
  }
  return {
    includedHoldings,
    measuredHoldings: measured.length,
    excluded: [...counts]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, holdings]) => ({ reason, holdings })),
    excludedValue: excludedValue.toString(),
  };
}

interface SeriesPoint {
  date: string;
  value: Decimal;
  /**
   * The same day's value split by the currency each holding is quoted in,
   * `null` for the share nothing could place. Sums to `value` exactly — it is
   * the same rows folded with one more key, not a second valuation.
   */
  byCurrency: Map<string | null, Decimal>;
  /** True when at least one in-scope holding was priced that day. */
  measured: boolean;
  /** Worst per-holding grade on the day — a scope is only as good as its worst row. */
  coverageQuality: string;
}

const QUALITY_ORDER: Record<string, number> = {
  full: 0,
  partial: 1,
  estimated: 2,
  unknown: 3,
};

/**
 * Per-holding rollup rows folded into one weighted value per day.
 *
 * A day where NO in-scope holding could be priced is dropped, not plotted at
 * zero — the same rule `hasKnownCoverage` applies to the chart and to the
 * exports (SC-95, SC-66). A zero there is the absence of a measurement, and
 * feeding it to a return chain would manufacture a -100% followed by an
 * infinite recovery.
 */
function buildSeries(
  rows: ReadonlyArray<{
    snapshotDate: string;
    holdingId: string;
    totalValue: string;
    coverageQuality: string;
    holdingsWithKnownValue: number;
    holdingsTotal: number;
  }>,
  weights: ReadonlyMap<string, Decimal>,
  currencyByHolding: ReadonlyMap<string, string | null>
): SeriesPoint[] {
  const byDate = new Map<string, SeriesPoint>();
  for (const row of rows) {
    const weight = weights.get(row.holdingId);
    if (!weight) continue;
    // A holding the day does not contain — before its first record, the
    // rollup counts nothing for it (SC-1323). Its row is not an unpriced
    // holding and must not grade the day 'unknown'.
    if (row.holdingsTotal === 0) continue;
    const date = String(row.snapshotDate).slice(0, 10);
    const existing = byDate.get(date) ?? {
      date,
      value: new Decimal(0),
      byCurrency: new Map<string | null, Decimal>(),
      measured: false,
      coverageQuality: 'full',
    };
    const weighted = new Decimal(row.totalValue).mul(weight);
    existing.value = existing.value.add(weighted);
    const currency = currencyByHolding.get(row.holdingId) ?? null;
    existing.byCurrency.set(currency, (existing.byCurrency.get(currency) ?? ZERO).add(weighted));
    if (row.holdingsWithKnownValue > 0) existing.measured = true;
    if (
      (QUALITY_ORDER[row.coverageQuality] ?? 3) > (QUALITY_ORDER[existing.coverageQuality] ?? 3)
    ) {
      existing.coverageQuality = row.coverageQuality;
    }
    byDate.set(date, existing);
  }
  return [...byDate.values()]
    .filter((point) => point.measured)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * A holding's first priced day inside the window, booked as money put in
 * (SC-1323).
 *
 * The rollup counts a holding only from its first record, so one added
 * mid-window steps the value up on the day it appears. Left unbooked, that
 * step is a market gain of its whole value — a 0.5 BTC typed in by hand
 * became "+$42,081". It is funding, like `opening_balance`: the value it
 * arrived with, less whatever its own ledger already booked into that day, so
 * a deposit recorded on the same day is not counted twice.
 *
 * A holding priced on the opening day is already inside the opening value and
 * books nothing.
 */
function arrivalFlows(
  rows: ReadonlyArray<{
    snapshotDate: string;
    holdingId: string;
    totalValue: string;
    holdingsWithKnownValue: number;
  }>,
  weights: ReadonlyMap<string, Decimal>,
  ledgerFlows: readonly ExternalFlow[],
  measuredDates: readonly string[],
  openingDate: string
): ExternalFlow[] {
  const arrival = new Map<string, { date: string; value: Decimal }>();
  for (const row of rows) {
    const weight = weights.get(row.holdingId);
    if (!weight || row.holdingsWithKnownValue <= 0) continue;
    const date = String(row.snapshotDate).slice(0, 10);
    const seen = arrival.get(row.holdingId);
    if (!seen || date < seen.date) {
      arrival.set(row.holdingId, { date, value: new Decimal(row.totalValue).mul(weight) });
    }
  }

  const sortedDates = [...measuredDates].sort();
  const bucketOf = (at: Date) => {
    const day = at.toISOString().slice(0, 10);
    return sortedDates.find((date) => date >= day);
  };

  const booked: ExternalFlow[] = [];
  for (const [holdingId, { date, value }] of arrival) {
    if (date <= openingDate || !sortedDates.includes(date)) continue;
    const ledger = ledgerFlows
      .filter((flow) => flow.holdingId === holdingId && bucketOf(flow.occurredAt) === date)
      .reduce((sum, flow) => sum.add(flow.baseAmount), new Decimal(0));
    const amount = value.sub(ledger);
    if (amount.isZero()) continue;
    booked.push({
      transactionId: `arrival:${holdingId}`,
      holdingId,
      kind: 'opening_balance',
      occurredAt: new Date(`${date}T00:00:00.000Z`),
      tokenId: '',
      quantity: '0',
      baseAmount: amount.toString(),
      valuationBasis: null,
      stale: false,
      weight: (weights.get(holdingId) as Decimal).toString(),
    });
  }
  return booked;
}

/**
 * The points that belong to the window, plus the opening anchor.
 *
 * The anchor is the last measured day strictly before `window.from`. When
 * there is none — an account whose whole history starts inside the window, or
 * the `'all'` window, which has no start of its own — the first measured day
 * inside becomes the anchor. Its own flows then sit inside its value and are
 * excluded, which is correct: nothing before the first measurement can be a
 * return.
 */
function selectWindowPoints(
  series: readonly SeriesPoint[],
  window: ResolvedReturnWindow
): SeriesPoint[] {
  const fromDate = window.from.toISOString().slice(0, 10);
  const toDate = window.to.toISOString().slice(0, 10);
  const inside = series.filter((point) => point.date >= fromDate && point.date <= toDate);
  if (inside.length === 0) return [];
  const before = series.filter((point) => point.date < fromDate);
  const anchor = before[before.length - 1];
  return anchor ? [anchor, ...inside] : inside;
}

/**
 * The investor's cashflows: money paid in is negative, money received is
 * positive.
 *
 * The opening value is a payment in — the owner "bought" the portfolio as it
 * stood — and the closing value is a receipt, as if it were sold on the last
 * measured day. That framing is what makes XIRR comparable to the return on a
 * single lump-sum investment, and it is what every spreadsheet does.
 *
 * Flows use their own `occurredAt`, not the day they were bucketed onto. TWR
 * needs the bucket because it chains per measured day; XIRR discounts each
 * flow individually and can use the real instant, so it does.
 *
 * ## Restatements are not cashflows (SC-510)
 *
 * `flows` carries `restatement` rows because TWR must subtract them from the
 * closing value — otherwise a corrected typo reads as a gain. XIRR must NOT
 * see them: nobody paid that money in, and booking a payment that never
 * happened discounts every real flow against it. `flowRoleOf` is the one
 * place that decides which is which.
 */
function toCashflows(
  first: SeriesPoint,
  last: SeriesPoint,
  flows: readonly ExternalFlow[],
  unattributed: readonly ExternalFlow[]
): Cashflow[] {
  const excluded = new Set(unattributed.map((flow) => flow.transactionId));
  const cashflows: Cashflow[] = [
    { at: new Date(`${first.date}T23:59:59.999Z`), amount: -first.value.toNumber() },
  ];
  for (const flow of flows) {
    if (excluded.has(flow.transactionId)) continue;
    if (flowRoleOf(flow.kind) === 'restatement') continue;
    const amount = new Decimal(flow.baseAmount);
    if (amount.isZero()) continue;
    cashflows.push({ at: flow.occurredAt, amount: -amount.toNumber() });
  }
  cashflows.push({ at: new Date(`${last.date}T23:59:59.999Z`), amount: last.value.toNumber() });
  return cashflows;
}

function emptyCoverage(window: ResolvedReturnWindow): ReturnsCoverage {
  return {
    measuredDays: 0,
    windowDays: Math.max(0, Math.round((window.to.getTime() - window.from.getTime()) / DAY_MS)),
    daysNotFullyCovered: 0,
    skippedPeriods: 0,
    unvaluedFlows: 0,
    staleValuedFlows: 0,
    flowsAfterLastMeasuredDay: 0,
  };
}
