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

  return { twr, xirr, fx, benchmarks: compared, since, partial };
}
