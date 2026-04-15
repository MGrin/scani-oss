import type { trpc } from '@/lib/trpc';

type TrpcUtils = ReturnType<typeof trpc.useUtils>;

/**
 * Invalidates every query whose result reflects the user's portfolio state.
 *
 * Why this helper exists
 * ----------------------
 * Almost every V2 mutation (create/update/delete of an account, holding,
 * institution, group, or vault) has cross-cutting effects: a deleted account
 * changes the accounts list, the dashboard totals, the asset-allocation chart,
 * the institution summary (account count, total value), the vault weights,
 * and the holdings list. Historically each call site picked its own subset of
 * `utils.*.invalidate()` calls and invariably missed one or two, so the UI
 * drifted out of sync with the backend until the user manually reloaded the
 * page.
 *
 * Centralizing the invalidation set here means:
 *   1. New queries added to any of these routers are picked up by every
 *      mutation automatically — call sites don't need to be updated.
 *   2. Every mutation behaves identically w.r.t. freshness, so bugs can't hide
 *      behind "this one dialog forgot to invalidate dashboard.getAssetAllocation".
 *   3. It's easy to audit: any mutation that affects the portfolio should
 *      `await invalidatePortfolioQueries(utils)` in its `onSuccess`.
 *
 * `refetchType` semantics
 * -----------------------
 * - `'all'` (default): force a refetch even for inactive observers. Use this
 *   after a mutation that will navigate to a new page — the destination
 *   isn't mounted yet at invalidation time, so the default `'active'` would
 *   just mark the cache stale and never refetch it.
 *
 * - `'active'`: only refetch queries currently visible to the user. Use this
 *   when the caller is a real-time update from the backend (WebSocket event)
 *   — we don't need to eagerly refetch pages the user can't see, and doing
 *   so would hammer the backend for every broadcast.
 *
 * Await the result before navigating so the destination page renders with
 * fresh data instead of a stale flash.
 */
export async function invalidatePortfolioQueries(
  utils: TrpcUtils,
  options: { refetchType?: 'all' | 'active' } = {}
): Promise<void> {
  const { refetchType = 'all' } = options;
  await Promise.all([
    utils.accounts.invalidate(undefined, { refetchType }),
    utils.holdings.invalidate(undefined, { refetchType }),
    utils.institutions.invalidate(undefined, { refetchType }),
    utils.dashboard.invalidate(undefined, { refetchType }),
    utils.vaults.invalidate(undefined, { refetchType }),
    utils.groups.invalidate(undefined, { refetchType }),
  ]);
}
