import Decimal from 'decimal.js';

/**
 * Time-weighted return — the chained daily-valuation method (SC-457).
 *
 * ## Why chained, and not `end / start - 1`
 *
 * A portfolio that received a deposit has not "gone up" by the deposit.
 * Nothing in Scani knew the difference before this: every figure on every
 * screen is a value or a value delta, and a value delta answers "how much
 * more money is in here" when the question people ask a portfolio tracker is
 * "how well did it do". TWR is the answer to the second question and it is
 * the only one that survives a contribution, because it never lets a flow
 * enter the numerator of any period's return.
 *
 * ## The convention, stated because there is more than one
 *
 * Sub-period `i` runs from the end of measured day `i-1` to the end of
 * measured day `i`, and its return is
 *
 *     r_i = (V_i - F_i) / V_{i-1} - 1
 *
 * where `F_i` is the net external flow that landed inside the sub-period,
 * positive into the portfolio. That is the **end-of-day flow** convention:
 * the flow is subtracted from the closing value, so it earns nothing during
 * the day it arrived. The alternative — `V_i / (V_{i-1} + F_i) - 1` — treats
 * it as invested from the open. Both are approximations of an intraday
 * truth we do not have, they differ by one day of return on one day's flows
 * (except when the flow dwarfs the opening; see `subPeriodFactor`),
 * and end-of-day is chosen because `portfolio_value_daily` holds an
 * END-of-day value (`RollupPortfolioValueDailyUseCase` stamps each day at
 * 23:59:59.999 UTC), so subtracting the flow from it is the arithmetic that
 * matches how the input was measured.
 *
 * ## Periods that cannot be measured
 *
 * `V_{i-1} <= 0` makes the ratio undefined — the portfolio held nothing to
 * earn a return ON. Those sub-periods contribute a factor of exactly 1 and
 * are COUNTED (`skippedPeriods`), never silently dropped: a chain that
 * quietly skipped a third of its periods is indistinguishable from one that
 * measured them all.
 *
 * A sub-period whose flow-adjusted close is negative (`V_i - F_i < 0`) is an
 * inconsistency between the value series and the ledger, not a -110% return.
 * The factor floors at 0 — total loss — and the period is marked. Value
 * cannot be negative, so this is the only reading that is not a fabrication.
 *
 * ## Annualization
 *
 * Reported only for spans of at least a year. Annualizing a 3-week return
 * multiplies its noise by 17 and prints the result as a yearly rate; GIPS
 * forbids it for exactly that reason, and `null` is the honest answer for a
 * window too short to have one.
 */

/** One measured end-of-day valuation of a scope, with the flows that reached it. */
export interface ValuationPoint {
  /** `YYYY-MM-DD`, the snapshot date whose END of day this value describes. */
  date: string;
  /** End-of-day value of the scope in base currency. */
  value: Decimal;
  /**
   * Net external flow inside `(previous point's end of day, this point's end
   * of day]`, base currency, POSITIVE into the scope. Ignored on the first
   * point — that one is the opening anchor and its flows are already inside
   * its value.
   */
  netExternalFlow: Decimal;
}

export interface TwrPeriod {
  from: string;
  to: string;
  startValue: string;
  endValue: string;
  netExternalFlow: string;
  /** `null` exactly when `measured` is false. */
  return: string | null;
  measured: boolean;
}

export interface TwrResult {
  /** Cumulative return over the whole window as a fraction: `0.12` = +12%. */
  cumulative: string;
  /** Compounded to a yearly rate, or `null` for a window under a year. */
  annualized: string | null;
  /**
   * Every sub-period, in order. Carried out rather than reduced away because
   * a benchmark comparison (SC-464) chains its own series over exactly these
   * boundaries — recomputing them from the scalar is impossible.
   */
  periods: TwrPeriod[];
  measuredPeriods: number;
  skippedPeriods: number;
  /** Days spanned by the chain, first anchor to last point. */
  spanDays: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS_PER_YEAR = 365;

/**
 * One sub-period's growth factor, `startValue > 0`.
 *
 * End-of-day, `(end − flow) / start`, while the flow is no larger than the
 * opening. An inflow LARGER than the opening counts from the open instead,
 * `end / (start + flow)` (SC-1432): end-of-day divides the day's whole gap by
 * the opening, so a £1,500 transfer into a £300 scope whose close sat £20 under
 * the flow's value read −6.7% for one day, where the money actually at work
 * that day moved −1.1%. An outflow is never re-based. Floored at zero for the
 * reason the header gives. Whether to re-base is `countsFromTheOpen`'s call.
 */
export function subPeriodFactor(
  startValue: Decimal,
  endValue: Decimal,
  flow: Decimal,
  fromTheOpen: boolean
): Decimal {
  if (fromTheOpen) return Decimal.max(endValue, 0).div(startValue.plus(flow));
  return Decimal.max(endValue.minus(flow), 0).div(startValue);
}

/**
 * Whether a sub-period's flow counts from the open (SC-1432): an inflow larger
 * than the opening, over ONE day. Across a gap the flow landed somewhere inside
 * a longer period, after part of its move, so counting it from the open would
 * expose it to a move it never felt; those keep end-of-day.
 */
export function countsFromTheOpen(
  fromDate: string,
  toDate: string,
  startValue: Decimal,
  flow: Decimal
): boolean {
  return flow.gt(startValue) && endOfDayUtc(toDate) - endOfDayUtc(fromDate) === DAY_MS;
}

function endOfDayUtc(date: string): number {
  return Date.parse(`${date}T23:59:59.999Z`);
}

/**
 * Chain `points` into a time-weighted return.
 *
 * Returns `null` when there is nothing to chain — fewer than two measured
 * points is not a return of zero, it is the absence of a measurement, and the
 * two must not render the same.
 */
export function computeTimeWeightedReturn(points: readonly ValuationPoint[]): TwrResult | null {
  if (points.length < 2) return null;

  const periods: TwrPeriod[] = [];
  let factor = new Decimal(1);
  let measuredPeriods = 0;
  let skippedPeriods = 0;

  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1] as ValuationPoint;
    const curr = points[i] as ValuationPoint;
    const startValue = prev.value;
    const flow = curr.netExternalFlow;

    if (startValue.lte(0)) {
      skippedPeriods += 1;
      periods.push({
        from: prev.date,
        to: curr.date,
        startValue: startValue.toString(),
        endValue: curr.value.toString(),
        netExternalFlow: flow.toString(),
        return: null,
        measured: false,
      });
      continue;
    }

    const periodFactor = subPeriodFactor(
      startValue,
      curr.value,
      flow,
      countsFromTheOpen(prev.date, curr.date, startValue, flow)
    );
    factor = factor.mul(periodFactor);
    measuredPeriods += 1;
    periods.push({
      from: prev.date,
      to: curr.date,
      startValue: startValue.toString(),
      endValue: curr.value.toString(),
      netExternalFlow: flow.toString(),
      return: periodFactor.minus(1).toString(),
      measured: true,
    });
  }

  const first = points[0] as ValuationPoint;
  const last = points[points.length - 1] as ValuationPoint;
  const spanDays = Math.round((endOfDayUtc(last.date) - endOfDayUtc(first.date)) / DAY_MS);
  const cumulative = factor.minus(1);

  let annualized: string | null = null;
  if (spanDays >= DAYS_PER_YEAR && factor.gt(0)) {
    annualized = factor.pow(new Decimal(DAYS_PER_YEAR).div(spanDays)).minus(1).toString();
  } else if (spanDays >= DAYS_PER_YEAR) {
    // factor is exactly 0 — everything was lost. Any positive root of 0 is 0.
    annualized = '-1';
  }

  return {
    cumulative: cumulative.toString(),
    annualized,
    periods,
    measuredPeriods,
    skippedPeriods,
    spanDays,
  };
}
