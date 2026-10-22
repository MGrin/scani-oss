export const LANES = ['dashboard', 'returns', 'income', 'review', 'household', 'default'] as const;
export type TrpcBatchLane = (typeof LANES)[number];

const isLane = (value: unknown): value is TrpcBatchLane =>
  typeof value === 'string' && (LANES as readonly string[]).includes(value);

/**
 * Exact paths, not a `portfolio.` prefix. `getNetWorthSeries` and
 * `getPnLSeries` live on the same router and are the fast half — moving them
 * into the slow lane would put the hero chart back behind the returns engine,
 * which is the defect this exists to remove.
 */
const RETURNS_PATHS: ReadonlySet<string> = new Set([
  'portfolio.getReturns',
  'portfolio.getReturnsComparison',
  // Same engine. In the default lane it held Home's household row, bills,
  // groups and vaults for as long as the engine took (SC-1742).
  'portfolio.getGainsByWrapper',
]);

/**
 * A caller may name a lane in the request context (`trpc: { context: { lane } }`)
 * to move one read off a fast batch without moving it for every caller.
 */
export function trpcBatchLane(path: string, context?: { lane?: unknown }): TrpcBatchLane {
  if (isLane(context?.lane)) return context.lane;
  if (path.startsWith('dashboard.')) return 'dashboard';
  if (RETURNS_PATHS.has(path)) return 'returns';
  // A ledger range read priced at receipt (SC-1644): off the hero chart's
  // batch, and off the returns engine's, which it does not need.
  if (path === 'portfolio.getIncome') return 'income';
  // The shell asks for it on every page, so in the default lane every page's
  // first batch waited on it (SC-1671).
  if (path === 'review.listPending') return 'review';
  // Production p90 0.7 s: in the default lane it held Settings > Data's fast
  // sections past the reveal (SC-1743).
  if (path === 'household.mine') return 'household';
  return 'default';
}
