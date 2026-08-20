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
  /**
   * react-query's infinite result carries these three; a plain query carries
   * none of them. Optional here so both kinds satisfy one interface — but see
   * `isPaginated` for why the test below is on `fetchNextPage` and not on
   * `hasNextPage` being absent.
   */
  hasNextPage?: boolean;
  fetchNextPage?: () => unknown;
  isFetchingNextPage?: boolean;
}

/** More rows exist on the server than the surface currently holds (SC-244). */
export interface V3MoreState {
  /** Ask for the next page. */
  fetch: () => void;
  isFetching: boolean;
}

export interface V3QueryState {
  isLoading: boolean;
  isError: boolean;
  /** The first error among the merged queries, or null. */
  error: unknown;
  /** Refetches the queries that failed — or all of them if none did. */
  retry: () => void;
  /**
   * `null` means the surface holds **the whole set**; non-null means it holds
   * a page of a larger one and names the way to widen it (SC-244).
   *
   * The distinction is the point. Without it `V3DataView` searched, filtered
   * and sorted a page of 25 while rendering "No transfers match 'Revolut'" —
   * the same sentence it uses for a user who has none. One value, two facts:
   * `docs/technical/2026-08-15_absence-and-refusal.md`.
   *
   * Derived here rather than passed by each surface deliberately. Every v3
   * list already routes its queries through `mergeQueries`, so a surface that
   * swaps a query for an infinite one gets the honest empty state without
   * touching its list config — and a future pairing cannot inherit the bug by
   * simply not knowing the prop existed, which is how the first two did.
   */
  more: V3MoreState | null;
}

/**
 * Positively: does this result page?
 *
 * `hasNextPage === undefined` would answer the same question and is the wrong
 * test — it reads "not a paginated query" and "a paginated query whose field I
 * failed to read" identically, which is this file's own defect class one layer
 * up. `fetchNextPage` is a function only on an infinite result, so its presence
 * is evidence rather than the absence of counter-evidence.
 */
function isPaginated(query: QueryLike): boolean {
  return typeof query.fetchNextPage === 'function';
}

/** A surface with nothing to wait for. Data that is already in hand, a list
 *  computed locally, a story in the gallery. */
export const SETTLED_QUERY_STATE: V3QueryState = {
  isLoading: false,
  isError: false,
  error: null,
  retry: () => {},
  more: null,
};

export function mergeQueries(...queries: readonly QueryLike[]): V3QueryState {
  const failed = queries.filter((query) => query.isError);
  // Failed first: a retry after a partial failure should not re-issue the four
  // requests that already succeeded. With nothing failed the button is a plain
  // refresh, so it refetches everything.
  const toRetry = failed.length > 0 ? failed : queries;
  const paginated = queries.filter(isPaginated);
  const withMore = paginated.filter((query) => query.hasNextPage === true);
  return {
    isLoading: queries.some((query) => query.isLoading),
    isError: failed.length > 0,
    error: failed[0]?.error ?? null,
    retry: () => {
      for (const query of toRetry) void query.refetch();
    },
    more:
      withMore.length > 0
        ? {
            fetch: () => {
              for (const query of withMore) void query.fetchNextPage?.();
            },
            isFetching: paginated.some((query) => query.isFetchingNextPage === true),
          }
        : null,
  };
}

/** For a data source that reports only whether it is loading — the v2 hooks
 *  (`useUserJobs`, `useReviewFeed`) own a websocket subscription and expose no
 *  error or refetch. Using this is a statement that the surface genuinely
 *  cannot report failure, not a shortcut: a tRPC query should pass through
 *  `mergeQueries` so a 500 renders as an error instead of an empty list. */
export function loadingOnly(isLoading: boolean): V3QueryState {
  return { isLoading, isError: false, error: null, retry: () => {}, more: null };
}
