export type TrpcBatchLane = 'dashboard' | 'returns' | 'income' | 'review' | 'default';

/**
 * Exact paths, not a `portfolio.` prefix. `getNetWorthSeries` and
 * `getPnLSeries` live on the same router and are the fast half — moving them
 * into the slow lane would put the hero chart back behind the returns engine,
 * which is the defect this exists to remove.
 */
const RETURNS_PATHS: ReadonlySet<string> = new Set([
  'portfolio.getReturns',
  'portfolio.getReturnsComparison',
]);

export function trpcBatchLane(path: string): TrpcBatchLane {
  if (path.startsWith('dashboard.')) return 'dashboard';
  if (RETURNS_PATHS.has(path)) return 'returns';
  // A ledger range read priced at receipt (SC-1644): off the hero chart's
  // batch, and off the returns engine's, which it does not need.
  if (path === 'portfolio.getIncome') return 'income';
  // The shell asks for it on every page, so in the default lane every page's
  // first batch waited on it (SC-1671).
  if (path === 'review.listPending') return 'review';
  return 'default';
}
