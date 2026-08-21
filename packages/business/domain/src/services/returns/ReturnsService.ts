import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { flowRoleOf } from '../../lib/returns/flow-classification';
import {
  type AttributionPoint,
  attributeCurrencyEffect,
  type CurrencyBucket,
  type ReturnAttribution,
} from '../../lib/returns/fx-attribution';
import { computeTimeWeightedReturn, type TwrResult } from '../../lib/returns/twr';
import {
  type ResolvedReturnWindow,
  type ReturnWindowRequest,
  resolveReturnWindow,
} from '../../lib/returns/window';
import { type Cashflow, type XirrResult, xirr } from '../../lib/returns/xirr';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { PortfolioValueDailyRepository } from '../../repositories/PortfolioValueDailyRepository';
import { UserRepository } from '../../repositories/UserRepository';
import { PriceGraphService } from '../pricing/PriceGraphService';
import { AssetCurrencyService } from './AssetCurrencyService';
import { type ExternalFlow, ExternalFlowService, netFlowByDate } from './ExternalFlowService';
import { type ReturnsScope, ReturnsScopeResolver } from './ReturnsScopeResolver';

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
}

@Service()
export class ReturnsService {
  private readonly scopeResolver = Container.get(ReturnsScopeResolver);
  private readonly flowService = Container.get(ExternalFlowService);
  private readonly dailyRepository = Container.get(PortfolioValueDailyRepository);
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
    const rows = await this.dailyRepository.findIncludedHoldingScopeRange(
      request.userId,
      baseCurrencyId,
      anchorFrom,
      window.to,
      undefined,
      request.scope.kind === 'user' ? undefined : holdings.map((h) => h.holdingId)
    );

    const weights = new Map(holdings.map((h) => [h.holdingId, h.weight]));
    // Which currency each holding's own price is set in, so the value series
    // can be split by currency as it is folded rather than re-walked after.
    const currencyByHolding = await this.currencyByHolding(holdings.map((h) => h.holdingId));
    const series = buildSeries(rows, weights, currencyByHolding);
    const points = selectWindowPoints(series, window);

    const requestedWindow = {
      kind: window.kind,
      from: window.from.toISOString().slice(0, 10),
      to: window.to.toISOString().slice(0, 10),
    };

    if (points.length === 0) {
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
          twr: null,
          attribution: null,
          xirr: { status: 'undefined', reason: 'too-few-flows' },
          coverage: emptyCoverage(window),
        },
      };
    }

    const first = points[0] as SeriesPoint;
    const last = points[points.length - 1] as SeriesPoint;

    // Only holdings that actually appear in the value series can contribute
    // flows. A holding with transactions but no rollup row is absent from the
    // value side too, and booking its flows against a value that never moved
    // would be a pure fabrication.
    const measuredHoldingIds = new Set(rows.map((row) => row.holdingId));
    const flowHoldings = holdings.filter((h) => measuredHoldingIds.has(h.holdingId));

    const flowWindowFrom = new Date(`${first.date}T23:59:59.999Z`);
    const flowWindowTo = new Date(`${last.date}T23:59:59.999Z`);
    const { flows, unvaluedCount, staleValuedCount } = await this.flowService.forHoldings(
      flowHoldings,
      baseCurrencyId,
      flowWindowFrom,
      flowWindowTo
    );

    const measuredDates = points.map((point) => point.date);
    const { byDate, byDateAndCurrency, unattributed } = netFlowByDate(
      flows,
      measuredDates.slice(1),
      currencyByHolding
    );

    const valuationPoints = points.map((point, index) => ({
      date: point.date,
      value: point.value,
      netExternalFlow: index === 0 ? new Decimal(0) : (byDate.get(point.date) ?? new Decimal(0)),
    }));

    const twr = computeTimeWeightedReturn(valuationPoints);
    const attribution = attributeCurrencyEffect(
      await this.attributionPoints(points, byDateAndCurrency, baseCurrencyId, window.to)
    );
    const netExternalFlow = valuationPoints.reduce(
      (sum, point) => sum.add(point.netExternalFlow),
      new Decimal(0)
    );

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
        twr,
        attribution,
        xirr: xirr(toCashflows(first, last, flows, unattributed)),
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
      },
    };
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
   * The rate work is bounded by ONE prefetch, whatever the window's length.
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

    const priceLookup = await this.priceGraphService.buildPriceLookup(
      currencyTokenIds,
      baseCurrencyId,
      until
    );

    for (const currencyTokenId of currencyTokenIds) {
      const byDate = new Map<string, Decimal | null>();
      for (const date of dates) {
        const conversion = await this.priceGraphService.convert(
          ONE,
          currencyTokenId,
          baseCurrencyId,
          new Date(`${date}T23:59:59.999Z`),
          // `daily` because these are end-of-day valuations and forex history
          // is written daily — 1,360 of production's 1,377 CAD rows are, and
          // the handful of intraday rows are mid-morning quotes that would
          // disagree with the close the value series was built from.
          { preferGranularity: 'daily', priceLookup }
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
  }>,
  weights: ReadonlyMap<string, Decimal>,
  currencyByHolding: ReadonlyMap<string, string | null>
): SeriesPoint[] {
  const byDate = new Map<string, SeriesPoint>();
  for (const row of rows) {
    const weight = weights.get(row.holdingId);
    if (!weight) continue;
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
