import { mergeQueries } from '@scani/ui/v3/lib/query-state';

/**
 * What a Home card is showing, decided from its queries (SC-1668).
 *
 * The shape a tRPC query result already has, so a block passes its queries
 * straight through.
 */
export interface HomeCardQuery {
  isLoading: boolean;
  fetchStatus: 'fetching' | 'paused' | 'idle';
  isFetching: boolean;
  isError: boolean;
  error: unknown;
  data: unknown;
  dataUpdatedAt: number;
  refetch: () => unknown;
}

export type HomeCardState =
  | { kind: 'loading'; retry: () => void }
  | { kind: 'error'; error: unknown; retry: () => void }
  | { kind: 'absent' }
  | { kind: 'loaded'; staleSince: number | null; refreshing: boolean; retry: () => void };

/**
 * Has no answer yet and is still going to get one.
 *
 * Neither React Query 4 flag says this alone. `isLoading` stays true forever
 * on a DISABLED query with no data (ReturnsBlock enables `getReturns` only
 * once `hasReturns` says there is history), so a card keyed on it never
 * leaves its skeleton. `isInitialLoading` is false on a PAUSED one — the app
 * runs `networkMode: 'online'`, so offline a first fetch pauses rather than
 * fetching — and a card keyed on it read an unanswered query as "you have
 * none". Only `fetchStatus === 'idle'` separates disabled from paused.
 */
function isPending(query: HomeCardQuery): boolean {
  return query.isLoading && query.fetchStatus !== 'idle';
}

/**
 * Loading, then error, then absent, then loaded — in that order, so `absent`
 * (the one state allowed to render nothing) can only follow queries that
 * answered. Before this, four blocks returned `null` while loading and on
 * error, and "you have no vaults" was indistinguishable from "vaults failed".
 *
 * A failure over data already on screen is not an error state: the figures
 * stay, with the time they are from. `dataUpdatedAt` is 0 for a query that
 * never answered, which would date the card to 1970, so those are skipped.
 */
export function resolveHomeCardState(
  queries: readonly HomeCardQuery[],
  absent: boolean
): HomeCardState {
  const pending = queries.filter(isPending);
  if (pending.length > 0) {
    // A disabled query refetches when asked to, so retrying "everything" would
    // fire the very call its `enabled` gate exists to hold back.
    return {
      kind: 'loading',
      retry: () => {
        for (const query of pending) void query.refetch();
      },
    };
  }

  const merged = mergeQueries(
    ...queries.map((query) => ({
      isLoading: false,
      isError: query.isError,
      error: query.error,
      refetch: query.refetch,
    }))
  );

  const blind = queries.find((query) => query.isError && query.data === undefined);
  if (blind) return { kind: 'error', error: blind.error, retry: merged.retry };

  if (absent) return { kind: 'absent' };

  const stale = queries.some((query) => query.isError);
  const answeredAt = queries.map((query) => query.dataUpdatedAt).filter((at) => at > 0);
  return {
    kind: 'loaded',
    staleSince: stale && answeredAt.length > 0 ? Math.min(...answeredAt) : null,
    // A query with data keeps `isError` while it retries, so without this the
    // footer looks unchanged until the retry lands.
    refreshing: queries.some((query) => query.isFetching),
    retry: merged.retry,
  };
}

const HOME_PEEK_IDS = [
  'hero',
  'allocation',
  'bills',
  'holdings',
  'returns',
  'income',
  'wrappers',
  'groups',
  'vaults',
  'debt',
] as const;

export type HomePeekId = (typeof HOME_PEEK_IDS)[number];

export function isHomePeekId(id: string | null): id is HomePeekId {
  return id !== null && (HOME_PEEK_IDS as readonly string[]).includes(id);
}
