export type TrpcBatchLane = 'dashboard' | 'returns' | 'default';

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
  return 'default';
}
