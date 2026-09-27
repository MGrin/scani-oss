// The CONFIGURED Decimal, not `decimal.js` directly: this file travels to the
// public mirror, whose root manifest does not declare the package, and a
// second unconfigured instance is the defect SC-889 closed rather than the
// declaration it looked like.
import { Decimal, splitChangeIntoMoney } from '@scani/shared';
import { toFiniteNumber } from '@scani/ui/v3/lib/numeric';
import type { RouterOutputs } from '@/lib/trpc';

/**
 * What Home's returns card shows, decided without a tRPC client (SC-1159).
 *
 * Two answers to "how did I do", and they disagree on purpose. The
 * time-weighted return ignores when money arrived: it is how the holdings
 * performed. The money-weighted one (XIRR) is what the reader's own money
 * earned, deposits and withdrawals included. Showing only one lets a well-timed
 * deposit pass for skill, or a badly timed one for a bad market.
 */

export type ReturnsWindow = 'ytd' | '1y' | 'all';

/**
 * What `getReturns` is actually asked for (SC-1305).
 *
 * The three NAMED windows are what the account and institution cards offer,
 * and they are a picker's values — a reader chooses "YTD". A `custom` range is
 * what the home chart sends: its period control already decides which days are
 * on the axis, and before this existed those days were mapped onto the nearest
 * named window, so 1M, 3M and 6M all asked for `1y` and the control moved
 * without changing anything on screen.
 *
 * Dates rather than date strings, because `z.coerce.date()` is what the router
 * parses and tRPC serialises a `Date` to the ISO string it coerces back.
 */
export type ReturnsWindowRequest =
  | { kind: ReturnsWindow }
  | { kind: 'custom'; from: Date; to: Date };

export const RETURNS_WINDOWS: readonly { key: ReturnsWindow; labelKey: string }[] = [
  { key: 'ytd', labelKey: 'v3.home.returns.window.ytd' },
  { key: '1y', labelKey: 'v3.home.returns.window.1y' },
  { key: 'all', labelKey: 'v3.home.returns.window.all' },
];

export const RETURNS_WINDOW_KEYS: readonly ReturnsWindow[] = RETURNS_WINDOWS.map((w) => w.key);

type Returns = NonNullable<RouterOutputs['portfolio']['getReturns']['returns']>;
type Benchmarks = RouterOutputs['portfolio']['getReturns']['benchmarks'];

export type BenchmarkKey = Benchmarks[number]['key'];

export const BENCHMARK_LABEL_KEYS: Record<BenchmarkKey, string> = {
  btc: 'v3.home.returns.benchmarks.btc',
  sp500: 'v3.home.returns.benchmarks.sp500',
  us_inflation: 'v3.home.returns.benchmarks.usInflation',
};

/**
 * The window in money, which is what the card leads with (SC-1297).
 *
 * Derived from `getReturns` alone — the cheap call — rather than from the
 * comparison procedure that carries the chart. The chart pays for one
 * benchmark price per measured day, and a card that went blank because a price
 * lookup timed out is the failure this separation exists to prevent.
 *
 * The arithmetic itself is `@scani/shared`'s `splitChangeIntoMoney`, the same
 * function the server's comparison payload is built with. Two copies would let
 * the bar and the chart above it disagree for a reason no reader could see.
 */
export interface ReturnsMoney {
  /** Closing value minus opening value, base currency. */
  change: number;
  /** Deposits minus withdrawals over the same days. */
  contributed: number;
  /** What the portfolio did on its own: `change - contributed`. */
  gain: number;
  /**
   * The gain's asset leg, carrying the cross term so `market + currency` is
   * the gain to the last digit — the bar's labels are read as a sum, and a
   * third segment for an interaction term is not a thing to explain on a home
   * screen.
   *
   * Null WITH `currency` when the rates cannot split it: over a window whose
   * base return is ~0 the two shares are enormous fractions of nothing. The
   * card then says "market and currency" rather than printing two numbers
   * that would swap sign on a rounding difference.
   */
  market: number | null;
  currency: number | null;
  /** The first measured day: what "since" in the sentence points at. */
  from: string;
  /** Flows the engine could not value. Never folded into a leg (SC-149). */
  unvalued: number;
}

export interface ReturnsView {
  /** Percent, not a fraction. `annualized` is null under a year. */
  twr: { cumulative: number; annualized: number | null } | null;
  /** Percent per year. `approximate` when more than one rate fits the flows. */
  xirr: { rate: number; approximate: boolean } | null;
  /**
   * The investment return split into what the holdings did in their own
   * currencies and what exchange rates did (SC-458). They compound, so the two
   * multiply to the whole rather than adding up to it. Null when there is no
   * split, or when rates did nothing because everything is in the base
   * currency.
   */
  fx: { asset: number; currency: number } | null;
  /**
   * What BTC and the S&P 500 did over the same measured days, in percent and
   * in the base currency (SC-464). Only the ones with a price at both ends.
   */
  benchmarks: { key: BenchmarkKey; cumulative: number }[];
  /** The first measured day, when the reader should know where "since" starts. */
  since: string | null;
  /** Some of the window could not be fully priced or valued. */
  partial: boolean;
  /** Null when the window has no value at one of its ends. */
  money: ReturnsMoney | null;
}

function percent(fraction: string | null | undefined): number | null {
  const value = toFiniteNumber(fraction);
  return value === null ? null : value * 100;
}

/**
 * `null` when there is nothing to say: no base currency, or too little history
 * for either figure. The card then renders nothing rather than a row of dashes
 * over a portfolio added today.
 */
export function returnsView(
  returns: Returns | null | undefined,
  benchmarks: Benchmarks = []
): ReturnsView | null {
  if (!returns) return null;

  const cumulative = percent(returns.twr?.cumulative);
  const twr =
    cumulative === null ? null : { cumulative, annualized: percent(returns.twr?.annualized) };
  const xirr =
    returns.xirr.status === 'ok' && Number.isFinite(returns.xirr.rate)
      ? { rate: returns.xirr.rate * 100, approximate: !returns.xirr.uniqueRoot }
      : null;
  if (!twr && !xirr) return null;

  const asset = percent(returns.attribution?.assetReturn);
  const currency = percent(returns.attribution?.currencyReturn);
  const fx = asset !== null && currency !== null && currency !== 0 ? { asset, currency } : null;

  // `all` resolves to the epoch and is narrowed to the first measured day, so
  // its start is only known from the answer. A year or YTD states its own
  // start, and needs saying only when history begins after it.
  const effective = returns.effectiveWindow;
  const since =
    effective &&
    (returns.requestedWindow.kind === 'all' || effective.from > returns.requestedWindow.from)
      ? effective.from
      : null;

  const coverage = returns.coverage;
  const partial =
    coverage.daysNotFullyCovered > 0 ||
    coverage.skippedPeriods > 0 ||
    coverage.unvaluedFlows > 0 ||
    coverage.staleValuedFlows > 0 ||
    (returns.attribution?.unattributedPeriods ?? 0) > 0;

  const compared = benchmarks.flatMap((b) => {
    const cumulative = percent(b.cumulative);
    return cumulative === null ? [] : [{ key: b.key, cumulative }];
  });

  return { twr, xirr, fx, benchmarks: compared, since, partial, money: moneyOf(returns) };
}

function moneyOf(returns: Returns): ReturnsMoney | null {
  const { startValue, endValue, effectiveWindow } = returns;
  if (startValue === null || endValue === null || !effectiveWindow) return null;

  const split = splitChangeIntoMoney({
    openingValue: new Decimal(startValue),
    closingValue: new Decimal(endValue),
    netFlow: new Decimal(returns.netExternalFlow),
    attribution: returns.attribution ?? null,
  });

  const gain = split.gain.toNumber();
  return {
    change: new Decimal(endValue).minus(startValue).toNumber(),
    contributed: split.contributions.toNumber(),
    gain,
    // The cross term is folded into the asset leg rather than shown, so the
    // two printed figures still add back to the gain exactly.
    currency: split.currency === null ? null : split.currency.toNumber(),
    market: split.currency === null ? null : gain - split.currency.toNumber(),
    from: effectiveWindow.from,
    unvalued: returns.coverage.unvaluedFlows,
  };
}
