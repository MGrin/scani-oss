import type { RouterOutputs, trpc } from '@/lib/trpc';

/**
 * Optimistic-update layer for V2 mutations.
 *
 * Every entry follows the same React Query recipe: the `optimistic*` wrapper
 * is called from a mutation's `onMutate` — it cancels in-flight refetches for
 * the queries it touches, snapshots them, applies an instant cache patch via
 * `setData`, and returns an {@link OptimisticSnapshot}. The mutation's
 * `onError` calls `snapshot.restore()` to roll back; `onSettled` still fires
 * `invalidatePortfolioQueries` so server-computed figures (dashboard totals,
 * valuations) reconcile a beat later.
 *
 * The pure list transforms are exported separately so they can be unit-tested
 * without React Query.
 */

type TrpcUtils = ReturnType<typeof trpc.useUtils>;

export interface OptimisticSnapshot {
  /** Roll the optimistic cache patch back to the pre-mutation state. */
  restore: () => void;
}

const NOOP_SNAPSHOT: OptimisticSnapshot = { restore: () => {} };

/**
 * Shallow-merge `patch` into `base`, skipping `undefined` values. A plain
 * `{ ...base, ...patch }` would overwrite a field with `undefined` whenever
 * the patch omits it — wiping data the mutation never intended to touch.
 * `null` is preserved (it's a meaningful "clear this field" value).
 */
function mergeDefined<T>(base: T, patch: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const value = patch[key];
    if (value !== undefined) {
      result[key] = value as T[keyof T];
    }
  }
  return result;
}

// ===========================================================================
// Holdings
// ===========================================================================

type HoldingsWithSummary = RouterOutputs['holdings']['getWithDetails'];
type HoldingRow = HoldingsWithSummary['holdings'][number];
type HiddenHoldings = RouterOutputs['holdings']['getHidden'];

/**
 * Recompute the holdings summary from scratch. Mirrors the backend
 * (`HoldingQueryService.getHoldingsByAccountIdWithSummary`): total counts all
 * rows, active counts `isActive` rows, total value sums priceable active rows.
 */
export function recountHoldingsSummary(holdings: HoldingRow[]): HoldingsWithSummary['summary'] {
  const active = holdings.filter((h) => h.isActive);
  const totalValue = active.reduce((sum, h) => (h.value !== null ? sum + h.value : sum), 0);
  return {
    totalCount: holdings.length,
    activeCount: active.length,
    totalValue: totalValue.toString(),
  };
}

export function removeHoldingsById(
  data: HoldingsWithSummary,
  ids: ReadonlySet<string>
): HoldingsWithSummary {
  const holdings = data.holdings.filter((h) => !ids.has(h.id));
  return { holdings, summary: recountHoldingsSummary(holdings) };
}

export function patchHoldingById(
  data: HoldingsWithSummary,
  id: string,
  patch: { amount?: number; isActive?: boolean }
): HoldingsWithSummary {
  const holdings = data.holdings.map((h) => (h.id === id ? mergeDefined(h, patch) : h));
  return { holdings, summary: recountHoldingsSummary(holdings) };
}

export function setTokenScamInHoldings(
  data: HoldingsWithSummary,
  tokenId: string,
  isScamProbability: number
): HoldingsWithSummary {
  const holdings = data.holdings.map((h) =>
    h.token.id === tokenId ? { ...h, token: { ...h.token, isScamProbability } } : h
  );
  // Scam status doesn't change values, so the summary is untouched.
  return { holdings, summary: data.summary };
}

export function setTokenScamInHidden(
  data: HiddenHoldings,
  tokenId: string,
  isScamProbability: number
): HiddenHoldings {
  return data.map((row) =>
    row.token.id === tokenId ? { ...row, token: { ...row.token, isScamProbability } } : row
  );
}

export async function optimisticRemoveHoldings(
  utils: TrpcUtils,
  ids: string[]
): Promise<OptimisticSnapshot> {
  await utils.holdings.getWithDetails.cancel();
  const prev = utils.holdings.getWithDetails.getData();
  if (!prev) return NOOP_SNAPSHOT;
  utils.holdings.getWithDetails.setData(undefined, removeHoldingsById(prev, new Set(ids)));
  return {
    restore: () => utils.holdings.getWithDetails.setData(undefined, prev),
  };
}

export async function optimisticPatchHolding(
  utils: TrpcUtils,
  id: string,
  patch: { amount?: number; isActive?: boolean }
): Promise<OptimisticSnapshot> {
  await utils.holdings.getWithDetails.cancel();
  const prev = utils.holdings.getWithDetails.getData();
  if (!prev) return NOOP_SNAPSHOT;
  utils.holdings.getWithDetails.setData(undefined, patchHoldingById(prev, id, patch));
  return {
    restore: () => utils.holdings.getWithDetails.setData(undefined, prev),
  };
}

export async function optimisticSetTokenScam(
  utils: TrpcUtils,
  tokenId: string,
  isScam: boolean
): Promise<OptimisticSnapshot> {
  const probability = isScam ? 1 : 0;
  await Promise.all([utils.holdings.getWithDetails.cancel(), utils.holdings.getHidden.cancel()]);
  const prevDetails = utils.holdings.getWithDetails.getData();
  const prevHidden = utils.holdings.getHidden.getData();
  if (prevDetails) {
    utils.holdings.getWithDetails.setData(
      undefined,
      setTokenScamInHoldings(prevDetails, tokenId, probability)
    );
  }
  if (prevHidden) {
    utils.holdings.getHidden.setData(
      undefined,
      setTokenScamInHidden(prevHidden, tokenId, probability)
    );
  }
  return {
    restore: () => {
      if (prevDetails) utils.holdings.getWithDetails.setData(undefined, prevDetails);
      if (prevHidden) utils.holdings.getHidden.setData(undefined, prevHidden);
    },
  };
}

export async function optimisticRemoveHiddenHolding(
  utils: TrpcUtils,
  id: string
): Promise<OptimisticSnapshot> {
  await utils.holdings.getHidden.cancel();
  const prev = utils.holdings.getHidden.getData();
  if (!prev) return NOOP_SNAPSHOT;
  utils.holdings.getHidden.setData(
    undefined,
    prev.filter((row) => row.id !== id)
  );
  return {
    restore: () => utils.holdings.getHidden.setData(undefined, prev),
  };
}

// ===========================================================================
// Accounts
// ===========================================================================

export async function optimisticRemoveAccounts(
  utils: TrpcUtils,
  ids: string[]
): Promise<OptimisticSnapshot> {
  const idSet = new Set(ids);
  await Promise.all([
    utils.accounts.getByUserIdWithSummary.cancel(),
    utils.accounts.getAll.cancel(),
  ]);
  const prevSummary = utils.accounts.getByUserIdWithSummary.getData();
  const prevAll = utils.accounts.getAll.getData();
  if (prevSummary) {
    utils.accounts.getByUserIdWithSummary.setData(
      undefined,
      prevSummary.filter((a) => !idSet.has(a.id))
    );
  }
  if (prevAll) {
    utils.accounts.getAll.setData(
      undefined,
      prevAll.filter((a) => !idSet.has(a.id))
    );
  }
  return {
    restore: () => {
      if (prevSummary) utils.accounts.getByUserIdWithSummary.setData(undefined, prevSummary);
      if (prevAll) utils.accounts.getAll.setData(undefined, prevAll);
    },
  };
}

export async function optimisticPatchAccount(
  utils: TrpcUtils,
  id: string,
  patch: { name?: string; description?: string | null }
): Promise<OptimisticSnapshot> {
  await Promise.all([
    utils.accounts.getByUserIdWithSummary.cancel(),
    utils.accounts.getAll.cancel(),
    utils.accounts.getById.cancel({ id }),
  ]);
  const prevSummary = utils.accounts.getByUserIdWithSummary.getData();
  const prevAll = utils.accounts.getAll.getData();
  const prevById = utils.accounts.getById.getData({ id });
  if (prevSummary) {
    utils.accounts.getByUserIdWithSummary.setData(
      undefined,
      prevSummary.map((a) => (a.id === id ? mergeDefined(a, patch) : a))
    );
  }
  if (prevAll) {
    utils.accounts.getAll.setData(
      undefined,
      prevAll.map((a) => (a.id === id ? mergeDefined(a, patch) : a))
    );
  }
  if (prevById) {
    utils.accounts.getById.setData({ id }, mergeDefined(prevById, patch));
  }
  return {
    restore: () => {
      if (prevSummary) utils.accounts.getByUserIdWithSummary.setData(undefined, prevSummary);
      if (prevAll) utils.accounts.getAll.setData(undefined, prevAll);
      if (prevById) utils.accounts.getById.setData({ id }, prevById);
    },
  };
}

// ===========================================================================
// Vaults
// ===========================================================================

interface VaultPatch {
  name?: string;
  color?: string;
  targetAmount?: string;
  description?: string | null;
  iconName?: string | null;
}

export async function optimisticRemoveVaults(
  utils: TrpcUtils,
  ids: string[]
): Promise<OptimisticSnapshot> {
  const idSet = new Set(ids);
  await utils.vaults.getAll.cancel();
  const prev = utils.vaults.getAll.getData();
  if (!prev) return NOOP_SNAPSHOT;
  utils.vaults.getAll.setData(
    undefined,
    prev.filter((v) => !idSet.has(v.id))
  );
  return {
    restore: () => utils.vaults.getAll.setData(undefined, prev),
  };
}

export async function optimisticPatchVault(
  utils: TrpcUtils,
  id: string,
  patch: VaultPatch
): Promise<OptimisticSnapshot> {
  await Promise.all([utils.vaults.getAll.cancel(), utils.vaults.getById.cancel({ id })]);
  const prevAll = utils.vaults.getAll.getData();
  const prevById = utils.vaults.getById.getData({ id });
  if (prevAll) {
    utils.vaults.getAll.setData(
      undefined,
      prevAll.map((v) => (v.id === id ? mergeDefined(v, patch) : v))
    );
  }
  if (prevById) {
    utils.vaults.getById.setData({ id }, mergeDefined(prevById, patch));
  }
  return {
    restore: () => {
      if (prevAll) utils.vaults.getAll.setData(undefined, prevAll);
      if (prevById) utils.vaults.getById.setData({ id }, prevById);
    },
  };
}

export async function optimisticDetachVaultHolding(
  utils: TrpcUtils,
  vaultId: string,
  holdingId: string
): Promise<OptimisticSnapshot> {
  await utils.vaults.getById.cancel({ id: vaultId });
  const prev = utils.vaults.getById.getData({ id: vaultId });
  if (!prev) return NOOP_SNAPSHOT;
  const holdings = prev.holdings.filter((h) => h.holdingId !== holdingId);
  utils.vaults.getById.setData(
    { id: vaultId },
    { ...prev, holdings, holdingsCount: holdings.length }
  );
  return {
    restore: () => utils.vaults.getById.setData({ id: vaultId }, prev),
  };
}

export async function optimisticSetVaultHoldingPercentage(
  utils: TrpcUtils,
  vaultId: string,
  holdingId: string,
  percentage: number
): Promise<OptimisticSnapshot> {
  await utils.vaults.getById.cancel({ id: vaultId });
  const prev = utils.vaults.getById.getData({ id: vaultId });
  if (!prev) return NOOP_SNAPSHOT;
  utils.vaults.getById.setData(
    { id: vaultId },
    {
      ...prev,
      holdings: prev.holdings.map((h) => (h.holdingId === holdingId ? { ...h, percentage } : h)),
    }
  );
  return {
    restore: () => utils.vaults.getById.setData({ id: vaultId }, prev),
  };
}

// ===========================================================================
// Groups
// ===========================================================================

interface GroupPatch {
  name?: string;
  color?: string;
  description?: string | null;
}

export async function optimisticRemoveGroups(
  utils: TrpcUtils,
  ids: string[]
): Promise<OptimisticSnapshot> {
  const idSet = new Set(ids);
  await Promise.all([utils.groups.getAll.cancel(), utils.groups.getAllWithCounts.cancel()]);
  const prevAll = utils.groups.getAll.getData();
  const prevCounts = utils.groups.getAllWithCounts.getData();
  if (prevAll) {
    utils.groups.getAll.setData(
      undefined,
      prevAll.filter((g) => !idSet.has(g.id))
    );
  }
  if (prevCounts) {
    utils.groups.getAllWithCounts.setData(
      undefined,
      prevCounts.filter((g) => !idSet.has(g.id))
    );
  }
  return {
    restore: () => {
      if (prevAll) utils.groups.getAll.setData(undefined, prevAll);
      if (prevCounts) utils.groups.getAllWithCounts.setData(undefined, prevCounts);
    },
  };
}

export async function optimisticPatchGroup(
  utils: TrpcUtils,
  id: string,
  patch: GroupPatch
): Promise<OptimisticSnapshot> {
  await Promise.all([
    utils.groups.getAll.cancel(),
    utils.groups.getAllWithCounts.cancel(),
    utils.groups.getById.cancel({ id }),
  ]);
  const prevAll = utils.groups.getAll.getData();
  const prevCounts = utils.groups.getAllWithCounts.getData();
  const prevById = utils.groups.getById.getData({ id });
  if (prevAll) {
    utils.groups.getAll.setData(
      undefined,
      prevAll.map((g) => (g.id === id ? mergeDefined(g, patch) : g))
    );
  }
  if (prevCounts) {
    utils.groups.getAllWithCounts.setData(
      undefined,
      prevCounts.map((g) => (g.id === id ? mergeDefined(g, patch) : g))
    );
  }
  if (prevById) {
    utils.groups.getById.setData({ id }, mergeDefined(prevById, patch));
  }
  return {
    restore: () => {
      if (prevAll) utils.groups.getAll.setData(undefined, prevAll);
      if (prevCounts) utils.groups.getAllWithCounts.setData(undefined, prevCounts);
      if (prevById) utils.groups.getById.setData({ id }, prevById);
    },
  };
}

/**
 * Instant insert of a freshly-created group into the list caches. Called from
 * `onSuccess` with the server-returned entity — no snapshot/rollback needed.
 */
export function insertCreatedGroup(
  utils: TrpcUtils,
  group: RouterOutputs['groups']['create']
): void {
  utils.groups.getAll.setData(undefined, (old) => (old ? [...old, group] : old));
  utils.groups.getAllWithCounts.setData(undefined, (old) =>
    old ? [...old, { ...group, holdingsCount: 0, accountsCount: 0 }] : old
  );
}

// ===========================================================================
// Sessions
// ===========================================================================

export async function optimisticRevokeSession(
  utils: TrpcUtils,
  token: string
): Promise<OptimisticSnapshot> {
  await utils.sessions.list.cancel();
  const prev = utils.sessions.list.getData();
  if (!prev) return NOOP_SNAPSHOT;
  utils.sessions.list.setData(
    undefined,
    prev.filter((s) => s.token !== token)
  );
  return {
    restore: () => utils.sessions.list.setData(undefined, prev),
  };
}

export async function optimisticRevokeOtherSessions(utils: TrpcUtils): Promise<OptimisticSnapshot> {
  await utils.sessions.list.cancel();
  const prev = utils.sessions.list.getData();
  if (!prev) return NOOP_SNAPSHOT;
  utils.sessions.list.setData(
    undefined,
    prev.filter((s) => s.isCurrent)
  );
  return {
    restore: () => utils.sessions.list.setData(undefined, prev),
  };
}

// ===========================================================================
// Users / settings
// ===========================================================================

type CurrentUser = RouterOutputs['users']['getCurrent'];
type BaseCurrency = RouterOutputs['users']['getBaseCurrency'];

export async function optimisticPatchUser(
  utils: TrpcUtils,
  patch: Partial<CurrentUser>,
  baseCurrency?: BaseCurrency
): Promise<OptimisticSnapshot> {
  await Promise.all([utils.users.getCurrent.cancel(), utils.users.getBaseCurrency.cancel()]);
  const prevUser = utils.users.getCurrent.getData();
  const prevBaseCurrency = utils.users.getBaseCurrency.getData();
  if (prevUser) {
    utils.users.getCurrent.setData(undefined, mergeDefined(prevUser, patch));
  }
  if (baseCurrency !== undefined) {
    utils.users.getBaseCurrency.setData(undefined, baseCurrency);
  }
  return {
    restore: () => {
      if (prevUser) utils.users.getCurrent.setData(undefined, prevUser);
      if (baseCurrency !== undefined) {
        utils.users.getBaseCurrency.setData(undefined, prevBaseCurrency);
      }
    },
  };
}
