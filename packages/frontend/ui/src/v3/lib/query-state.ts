/**
 * One collapsed state for a surface fed by several queries.
 *
 * Every v3 screen reads three to five tRPC queries and then renders one list.
 * Before this, each call site spelled out `a.isLoading || b.isLoading ||
 * c.isLoading` and simply dropped the error halves on the floor — `MoneyPage`
 * rendered `vendors.data ?? []` on a failed request, so a 500 from the server
 * was indistinguishable from an account with no vendors, and the empty state
 * invited the user to create one they already had.
 *
 * Collapsing here makes the error impossible to forget: the surface takes a
 * `V3QueryState`, and a state carries a retry that actually refetches.
 */

/** The half of react-query's result a v3 surface is allowed to read. */
export interface QueryLike {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
}

export interface V3QueryState {
  isLoading: boolean;
  isError: boolean;
  /** The first error among the merged queries, or null. */
  error: unknown;
  /** Refetches the queries that failed — or all of them if none did. */
  retry: () => void;
}

/** A surface with nothing to wait for. Data that is already in hand, a list
 *  computed locally, a story in the gallery. */
export const SETTLED_QUERY_STATE: V3QueryState = {
  isLoading: false,
  isError: false,
  error: null,
  retry: () => {},
};

export function mergeQueries(...queries: readonly QueryLike[]): V3QueryState {
  const failed = queries.filter((query) => query.isError);
  // Failed first: a retry after a partial failure should not re-issue the four
  // requests that already succeeded. With nothing failed the button is a plain
  // refresh, so it refetches everything.
  const toRetry = failed.length > 0 ? failed : queries;
  return {
    isLoading: queries.some((query) => query.isLoading),
    isError: failed.length > 0,
    error: failed[0]?.error ?? null,
    retry: () => {
      for (const query of toRetry) void query.refetch();
    },
  };
}

/** For a data source that reports only whether it is loading — the v2 hooks
 *  (`useUserJobs`, `useReviewFeed`) own a websocket subscription and expose no
 *  error or refetch. Using this is a statement that the surface genuinely
 *  cannot report failure, not a shortcut: a tRPC query should pass through
 *  `mergeQueries` so a 500 renders as an error instead of an empty list. */
export function loadingOnly(isLoading: boolean): V3QueryState {
  return { isLoading, isError: false, error: null, retry: () => {} };
}
