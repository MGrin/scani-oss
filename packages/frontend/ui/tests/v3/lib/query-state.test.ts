import { describe, expect, test } from 'bun:test';
import { mergeQueries, type QueryLike, SETTLED_QUERY_STATE } from '@scani/ui/v3/lib/query-state';

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

describe('SETTLED_QUERY_STATE', () => {
  test('is the default for a surface with nothing to wait for', () => {
    expect(SETTLED_QUERY_STATE.isLoading).toBe(false);
    expect(SETTLED_QUERY_STATE.isError).toBe(false);
    // Callable rather than optional, so a surface never has to branch on it.
    expect(() => SETTLED_QUERY_STATE.retry()).not.toThrow();
  });
});
