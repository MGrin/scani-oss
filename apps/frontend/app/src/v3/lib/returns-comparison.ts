import { toFiniteNumber } from '@scani/ui/v3/lib/numeric';
import type { RouterOutputs } from '@/lib/trpc';
import type { BenchmarkKey } from './returns';

/**
 * The comparison chart and the ahead/behind rows, decided without a tRPC
 * client (SC-1297).
 *
 * `portfolio.getReturnsComparison` is the expensive call — one benchmark price
 * per measured day — and it is separate from `getReturns` so the card's
 * sentence and its attribution bar render without it and survive it failing.
 * Everything here is therefore allowed to be absent; nothing here is allowed
 * to invent a value for a day nobody priced.
 */

export type ComparisonPayload = RouterOutputs['portfolio']['getReturnsComparison'];

/**
 * Colour, dash and legend key per series, keyed by the ENTITY.
 *
 * Not by position in the rendered list: a window where the S&P has no price
 * must not repaint Bitcoin, which is what indexing into a palette array would
 * do. Values are `hsl(var(--chart-N))` rather than resolved hexes, which is
 * what makes a theme flip repaint with no re-render — see `ChartFrame`.
 *
 * Each line also carries its own dash, so the four are told apart without
 * colour: the two ghosts are dashed against the portfolio's solid stroke, and
 * inflation is the finest dot of the three because it is a break-even mark
 * rather than something anybody held.
 */
export const COMPARISON_SERIES = {
  // Ink rather than a ramp slot: one of these four is the subject and the
  // other three are references, and it keeps the identity slots free for the
  // attribution bar on the same card.
  portfolio: {
    color: 'hsl(var(--foreground))',
    dash: undefined,
    labelKey: 'v3.home.returns.chart.you',
  },
  btc: { color: 'hsl(var(--chart-2))', dash: '6 3', labelKey: 'v3.home.returns.benchmarks.btc' },
  sp500: {
    color: 'hsl(var(--chart-3))',
    dash: '2 3',
    labelKey: 'v3.home.returns.benchmarks.sp500',
  },
  us_inflation: {
    color: 'hsl(var(--chart-other))',
    dash: '1 4',
    labelKey: 'v3.home.returns.benchmarks.usInflation',
  },
} as const satisfies Record<
  'portfolio' | BenchmarkKey,
  { color: string; dash?: string; labelKey: string }
>;

/** Fixed display order — the same order in the legend, the chart and the rows. */
const COMPARISON_BENCHMARKS: readonly BenchmarkKey[] = ['btc', 'sp500', 'us_inflation'];

export interface ComparisonPoint {
  date: string;
  portfolio: number | null;
  btc: number | null;
  sp500: number | null;
  us_inflation: number | null;
}

interface BenchmarkGap {
  key: BenchmarkKey;
  /** Ahead (+) or behind (−) of the same money in that benchmark, at the end. */
  money: number;
  /** What the benchmark itself returned, percent — the row's caption. */
  cumulative: number | null;
}

export interface ComparisonView {
  points: ComparisonPoint[];
  /** The benchmarks with at least one priced day, in display order. */
  lines: BenchmarkKey[];
  gaps: BenchmarkGap[];
  /** The window held more days than the cap, so the series is sampled. */
  truncated: boolean;
}

/**
 * `null` when there is nothing to draw. A single point is not a line, and a
 * chart of one dot over a window the card has already described in a sentence
 * is noise — but the gaps beside it are still worth having, so the view
 * survives with an empty `points`.
 */
export function comparisonView(
  payload: ComparisonPayload | undefined,
  benchmarks: { key: BenchmarkKey; cumulative: number }[] = []
): ComparisonView | null {
  const comparison = payload?.comparison;
  if (!comparison) return null;

  const points = comparison.chart.map((point) => ({
    date: point.date,
    portfolio: toFiniteNumber(point.portfolio),
    // `undefined` on the wire is a day the benchmark had no price. It becomes
    // `null` here and `connectNulls={false}` leaves a HOLE there: a straight
    // segment across it would be a price we are asserting and do not have.
    btc: toFiniteNumber(point.benchmarks.btc),
    sp500: toFiniteNumber(point.benchmarks.sp500),
    us_inflation: toFiniteNumber(point.benchmarks.us_inflation),
  }));

  const lines = COMPARISON_BENCHMARKS.filter((key) => points.some((point) => point[key] !== null));

  const cumulativeOf = new Map(benchmarks.map((b) => [b.key, b.cumulative]));
  const gaps = COMPARISON_BENCHMARKS.flatMap((key) => {
    const gap = comparison.gaps.find((entry) => entry.key === key);
    const money = toFiniteNumber(gap?.money);
    return money === null ? [] : [{ key, money, cumulative: cumulativeOf.get(key) ?? null }];
  });

  return { points: points.length < 2 ? [] : points, lines, gaps, truncated: payload.truncated };
}
