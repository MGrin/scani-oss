/**
 * What a portfolio's return is compared against (SC-464).
 *
 * "Up 8%" says nothing without "against what". Two benchmarks, both priced by
 * providers already in the registry: Bitcoin through CoinGecko, and the S&P
 * 500 through Yahoo. Yahoo prices stock-style tickers only, so the index is
 * read through SPY, the ETF that tracks it; its daily close follows the
 * index's price return, and the label says SPY so nobody takes it for the
 * index itself. Inflation is SC-1255: no provider here has a CPI series.
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
