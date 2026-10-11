import type { trpc } from '@/lib/trpc';

type TrpcUtils = ReturnType<typeof trpc.useUtils>;

/**
 * Invalidates every query whose result reflects the user's portfolio state.
 *
 * Why this helper exists
 * ----------------------
 * Almost every portfolio mutation (create/update/delete of an account, holding,
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
 *   eagerly refetch pages the user can't see. Each of these routers covers
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
    // The holding peek's activity list (SC-1527): a recorded movement or a
    // balance edit writes ledger rows, and without this the peek kept its
    // cached list until a reload.
    utils.transactions.invalidate(undefined, { refetchType }),
    // A liability's amount owed and payoff are read from its holding (SC-1640).
    utils.liabilities.invalidate(undefined, { refetchType }),
  ]);
}

/**
 * Narrower invalidation for vault-only mutations (create / update / delete a
 * vault; attach / detach / re-weight a holding within one).
 *
 * Vaults are a savings-goal grouping layer — they never change holding
 * balances, account balances, token prices, or net worth. So account totals,
 * dashboard figures, asset allocation, institution summaries, and groups
 * cannot change, and refetching them — especially the CPU-heavy `dashboard.*`
 * whole-portfolio valuations — on every vault edit was pure waste that fed
 * the backend's CPU-saturation outages. `holdings` is kept because a holding
 * row surfaces its vault membership.
 */
export async function invalidateVaultQueries(
  utils: TrpcUtils,
  options: { refetchType?: 'all' | 'active' } = {}
): Promise<void> {
  const { refetchType = 'active' } = options;
  await Promise.all([
    utils.vaults.invalidate(undefined, { refetchType }),
    utils.holdings.invalidate(undefined, { refetchType }),
  ]);
}

/**
 * After the base currency changes, every figure is re-denominated — including
 * the Home hero, which reads `portfolio.*` and is not in the portfolio set
 * above, so it kept the old currency's total until a reload (SC-1530).
 * `portfolio.*` stays out of that set on purpose: it is the whole-history
 * valuation, too heavy to refetch on every holding edit.
 */
export async function invalidateAfterCurrencyChange(utils: TrpcUtils): Promise<void> {
  await Promise.all([
    invalidatePortfolioQueries(utils, { refetchType: 'all' }),
    utils.portfolio.invalidate(undefined, { refetchType: 'all' }),
  ]);
}

/**
 * A `user` realtime event. Every one refreshes the user queries; a
 * base-currency change, made in another tab or on another device, also
 * re-denominates every figure.
 */
export async function invalidateForUserEvent(
  utils: TrpcUtils,
  metadata: Record<string, unknown> | undefined
): Promise<void> {
  const refreshes: Promise<unknown>[] = [
    utils.users.getCurrent.invalidate(),
    utils.users.getBaseCurrency.invalidate(),
  ];
  // The same refresh as the tab that made the change: without `portfolio.*`
  // the hero and the returns stayed in the old currency here (SC-1599).
  if (metadata?.source === 'base-currency-change')
    refreshes.push(invalidateAfterCurrencyChange(utils));
  await Promise.all(refreshes);
}

/**
 * After the socket reopens. Realtime keeps no replay, so every event sent
 * while it was down is lost; refetch what those events would have refreshed.
 * `'active'` only: what is off screen is marked stale and refetches when it
 * mounts, so a reconnect costs one fetch per query on screen (SC-1599).
 */
export async function resyncAfterReconnect(utils: TrpcUtils): Promise<void> {
  await Promise.all([
    invalidatePortfolioQueries(utils, { refetchType: 'active' }),
    utils.portfolio.invalidate(undefined, { refetchType: 'active' }),
    utils.jobs.invalidate(undefined, { refetchType: 'active' }),
    utils.review.invalidate(undefined, { refetchType: 'active' }),
    utils.users.invalidate(undefined, { refetchType: 'active' }),
  ]);
}

// Realtime entity types whose change moves the portfolio set.
const PORTFOLIO_ENTITY_TYPES = new Set<string>([
  'account',
  'holding',
  'institution',
  'vault',
  'group',
  'token',
]);

/** An `account`/`holding`/… realtime event: refresh what is on screen. */
export async function invalidateForEntityEvent(
  utils: TrpcUtils,
  entityType: string | undefined
): Promise<void> {
  // The history was rebuilt: only the chart series read it (SC-1600).
  if (entityType === 'portfolio') {
    await utils.portfolio.invalidate(undefined, { refetchType: 'active' });
    return;
  }
  if (!entityType || !PORTFOLIO_ENTITY_TYPES.has(entityType)) return;
  await invalidatePortfolioQueries(utils, { refetchType: 'active' });
}
