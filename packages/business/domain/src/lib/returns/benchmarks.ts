/**
 * What a portfolio's return is compared against (SC-464).
 *
 * "Up 8%" says nothing without "against what". Two benchmarks, both priced by
 * providers already in the registry: Bitcoin through CoinGecko, and the S&P
 * 500 through Yahoo. Yahoo prices stock-style tickers only, so the index is
 * read through SPY, the ETF that tracks it; its daily close follows the
 * index's price return, and the label says SPY so nobody takes it for the
 * index itself.
 *
 * Inflation is the third line (SC-1255), and it is not a token: a consumer
 * price index is a rate nobody holds, read monthly from BLS and never
 * converted into the reader's currency. It is US inflation and says so.
 */
export interface Benchmark {
  key: 'btc' | 'sp500';
  symbol: string;
  name: string;
  typeCode: 'crypto' | 'stock';
  /** `tokens.market_segment`: null for crypto, the listing for an equity. */
  marketSegment: string | null;
}

export const BENCHMARKS: readonly Benchmark[] = [
  { key: 'btc', symbol: 'BTC', name: 'Bitcoin', typeCode: 'crypto', marketSegment: null },
  {
    key: 'sp500',
    symbol: 'SPY',
    name: 'SPDR S&P 500 ETF Trust',
    typeCode: 'stock',
    marketSegment: 'US',
  },
];

export const US_INFLATION = {
  key: 'us_inflation',
  /** CPI-U, all items, US city average, not seasonally adjusted. */
  seriesId: 'CUUR0000SA0',
  source: 'bls',
} as const;

export type BenchmarkKey = Benchmark['key'] | typeof US_INFLATION.key;

/** The first day of the month `day` falls in, `YYYY-MM-01`. */
export function monthOf(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * The days a benchmark's history still needs, as UTC midnights.
 *
 * Only the EDGES: from the earliest day any portfolio was measured to the day
 * before the first stored close, and from the day after the last stored close
 * to `through`. Interior gaps are weekends and market holidays for an equity,
 * which no provider will ever fill; asking for them every night would re-request
 * the whole history forever.
 */
export function benchmarkDaysToFetch(opts: {
  earliestNeeded: Date | null;
  storedFirst: Date | null;
  storedLast: Date | null;
  through: Date;
}): Date[] {
  if (!opts.earliestNeeded) return [];
  const start = utcDay(opts.earliestNeeded);
  const end = utcDay(opts.through);
  const days: Date[] = [];
  const push = (from: number, to: number) => {
    for (let t = from; t <= to; t += DAY_MS) days.push(new Date(t));
  };
  if (!opts.storedFirst || !opts.storedLast) {
    push(start, end);
    return days;
  }
  push(start, utcDay(opts.storedFirst) - DAY_MS);
  push(Math.max(start, utcDay(opts.storedLast) + DAY_MS), end);
  return days;
}
