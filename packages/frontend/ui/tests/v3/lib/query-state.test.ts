import { describe, expect, test } from 'bun:test';
import {
  loadingOnly,
  mergeQueries,
  type QueryLike,
  SETTLED_QUERY_STATE,
} from '@scani/ui/v3/lib/query-state';

function query(overrides: Partial<QueryLike> = {}): QueryLike & { refetched: () => number } {
  let calls = 0;
  const base: QueryLike = {
    isLoading: false,
    isError: false,
    error: null,
    refetch: () => {
      calls += 1;
    },
  };
  return { ...base, ...overrides, refetched: () => calls };
}

describe('mergeQueries', () => {
  test('a surface is loading while any of its queries is', () => {
    expect(mergeQueries(query(), query({ isLoading: true })).isLoading).toBe(true);
    expect(mergeQueries(query(), query()).isLoading).toBe(false);
  });

  test('carries the first error rather than dropping it', () => {
    const boom = { data: { httpStatus: 500 } };
    const state = mergeQueries(query(), query({ isError: true, error: boom }));
    expect(state.isError).toBe(true);
    expect(state.error).toBe(boom);
  });

  /** The bug this type exists to prevent: `MoneyPage` rendered `vendors.data ??
   *  []` on a failed request, so a 500 was indistinguishable from an account
   *  with no vendors and the empty state invited the user to re-create them. */
  test('a failed query cannot be merged into a clean state', () => {
    expect(mergeQueries(query({ isError: true, error: new Error('x') })).isError).toBe(true);
  });

  test('retry refetches only what failed', () => {
    const ok = query();
    const failed = query({ isError: true, error: new Error('x') });
    mergeQueries(ok, failed).retry();
    expect(failed.refetched()).toBe(1);
    expect(ok.refetched()).toBe(0);
  });

  test('with nothing failed, retry is a plain refresh of everything', () => {
    const a = query();
    const b = query();
    mergeQueries(a, b).retry();
    expect(a.refetched()).toBe(1);
    expect(b.refetched()).toBe(1);
  });

  test('no queries is a settled surface', () => {
    const state = mergeQueries();
    expect(state.isLoading).toBe(false);
    expect(state.isError).toBe(false);
    expect(state.error).toBeNull();
  });
});

/**
 * SC-244. `more` is the difference between "you have none" and "we only looked
 * at the first 25", and it is derived here rather than declared by each surface
 * so a page that swaps a query for an infinite one cannot forget to say so.
 */
describe('mergeQueries — a page of a larger set', () => {
  function infinite(overrides: Partial<QueryLike> = {}) {
    let fetched = 0;
    return {
      ...query({
        hasNextPage: true,
        isFetchingNextPage: false,
        fetchNextPage: () => {
          fetched += 1;
        },
        ...overrides,
      }),
      fetchedNext: () => fetched,
    };
  }

  test('a plain query is the whole set, positively', () => {
    expect(mergeQueries(query(), query()).more).toBeNull();
  });

  test('an infinite query with another page names the way to widen it', () => {
    const page = infinite();
    const state = mergeQueries(page);
    expect(state.more).not.toBeNull();
    state.more?.fetch();
    expect(page.fetchedNext()).toBe(1);
  });

  test('an infinite query on its last page is the whole set', () => {
    expect(mergeQueries(infinite({ hasNextPage: false })).more).toBeNull();
  });

  /**
   * The negative that matters, and the reason `isPaginated` tests
   * `fetchNextPage` rather than `hasNextPage === undefined`: a paginated result
   * whose flag we failed to read would otherwise be reported as complete —
   * which is the class this whole ticket is about, one layer up.
   */
  test('a paginated query is recognised even when its flag is not yet known', () => {
    const state = mergeQueries(infinite({ hasNextPage: undefined }));
    // Not more (nothing says there IS another page), but not mistaken for a
    // plain query either: the moment `hasNextPage` resolves true, it reports.
    expect(state.more).toBeNull();
    expect(mergeQueries(infinite({ hasNextPage: true })).more).not.toBeNull();
  });

  test('fetching the next page is visible to the surface', () => {
    const state = mergeQueries(infinite({ isFetchingNextPage: true }));
    expect(state.more?.isFetching).toBe(true);
  });

  test('a settled or loading-only state claims the whole set', () => {
    expect(SETTLED_QUERY_STATE.more).toBeNull();
    expect(loadingOnly(true).more).toBeNull();
  });
});

describe('SETTLED_QUERY_STATE', () => {
  test('is the default for a surface with nothing to wait for', () => {
    expect(SETTLED_QUERY_STATE.isLoading).toBe(false);
    expect(SETTLED_QUERY_STATE.isError).toBe(false);
    // Callable rather than optional, so a surface never has to branch on it.
    expect(() => SETTLED_QUERY_STATE.retry()).not.toThrow();
  });
});
