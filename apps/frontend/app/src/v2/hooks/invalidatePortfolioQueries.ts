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
 *      call `invalidatePortfolioQueries(utils)` in its `onSuccess`.
 *
 * `refetchType` semantics
 * -----------------------
 * - `'active'` (default): only refetch queries currently visible to the user.
 *   This is the right default for same-page mutations — we don't need to
 *   eagerly refetch pages the user can't see. Each of the six routers covers
 *   many queries; with `'all'` a single mutation can fan out into a dozen
 *   refetches, which was making dialogs feel sluggish because they blocked
 *   on the full invalidation before closing.
 *
 * - `'all'`: force a refetch even for inactive observers. Use this after a
 *   mutation that will navigate to a new page — the destination isn't mounted
 *   yet at invalidation time, so the default `'active'` would just mark the
 *   cache stale and never refetch it.
 *
 * Fire-and-forget pattern
 * -----------------------
 * Dialogs should NOT await this helper before closing — the user shouldn't
 * have to wait for every portfolio query to refetch just to see their action
 * acknowledged. Close the dialog first, then invalidate in the background.
 * Only await when the next render truly depends on fresh data (e.g. before
 * navigating to a detail page that would otherwise flash stale content).
 */
export async function invalidatePortfolioQueries(
  utils: TrpcUtils,
  options: { refetchType?: 'all' | 'active' } = {}
): Promise<void> {
  const { refetchType = 'active' } = options;
  await Promise.all([
    utils.accounts.invalidate(undefined, { refetchType }),
    utils.holdings.invalidate(undefined, { refetchType }),
    utils.institutions.invalidate(undefined, { refetchType }),
    utils.dashboard.invalidate(undefined, { refetchType }),
    utils.vaults.invalidate(undefined, { refetchType }),
    utils.groups.invalidate(undefined, { refetchType }),
  ]);
}
