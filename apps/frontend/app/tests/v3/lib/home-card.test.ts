import '../../i18n-preload';

import { describe, expect, mock, test } from 'bun:test';
import { type HomeCardQuery, resolveHomeCardState } from '../../../src/v3/lib/home-card';

/**
 * SC-1668. Six of nine Home cards had no visible error state, and four of
 * them returned `null` while loading too, so a failed query and "you have no
 * vaults" looked identical. Every case below is one of those readings.
 */

function q(overrides: Partial<HomeCardQuery> = {}): HomeCardQuery {
  return {
    isLoading: false,
    fetchStatus: 'idle',
    isFetching: false,
    isError: false,
    error: null,
    data: { ok: true },
    dataUpdatedAt: 1000,
    refetch: () => {},
    ...overrides,
  };
}

describe('resolveHomeCardState', () => {
  test('any initial load is loading', () => {
    const state = resolveHomeCardState(
      [q(), q({ isLoading: true, fetchStatus: 'fetching', isFetching: true, data: undefined })],
      false
    );
    expect(state.kind).toBe('loading');
  });

  test('an error with no data is the error state, carrying that error', () => {
    const error = new Error('boom');
    const state = resolveHomeCardState([q(), q({ isError: true, error, data: undefined })], false);
    expect(state.kind).toBe('error');
    if (state.kind === 'error') expect(state.error).toBe(error);
  });

  // React Query 4: a disabled query with no data reads `isLoading: true`
  // forever, with `fetchStatus: 'idle'`. It is settled, not loading.
  test('a disabled query with no data does not hold the card in loading', () => {
    const disabled = q({ data: undefined, isLoading: true, fetchStatus: 'idle' });
    expect(resolveHomeCardState([q(), disabled], true).kind).toBe('absent');
    expect(resolveHomeCardState([q(), disabled], false).kind).toBe('loaded');
  });

  // `networkMode: 'online'`: offline, a first fetch PAUSES — `isFetching` is
  // false, so `isInitialLoading` is too, and a card keyed on it read an
  // unanswered query as "you have none".
  test('a query paused for the network is still loading, never absent', () => {
    const paused = q({ data: undefined, isLoading: true, fetchStatus: 'paused' });
    expect(resolveHomeCardState([paused], true).kind).toBe('loading');
  });

  test('the stalled-loading retry refetches only the queries still waiting', () => {
    const settled = mock(() => {});
    const disabled = mock(() => {});
    const waiting = mock(() => {});
    const state = resolveHomeCardState(
      [
        q({ refetch: settled }),
        q({ data: undefined, isLoading: true, fetchStatus: 'idle', refetch: disabled }),
        q({ data: undefined, isLoading: true, fetchStatus: 'paused', refetch: waiting }),
      ],
      false
    );
    if (state.kind !== 'loading') throw new Error(`expected loading, got ${state.kind}`);
    state.retry();
    expect(waiting).toHaveBeenCalledTimes(1);
    expect(settled).not.toHaveBeenCalled();
    expect(disabled).not.toHaveBeenCalled();
  });

  test('a stale card says when it is already refreshing', () => {
    const state = resolveHomeCardState([q({ isError: true, isFetching: true })], false);
    expect(state.kind === 'loaded' && state.refreshing).toBe(true);
  });

  test('absent is never reported while loading or failed', () => {
    expect(
      resolveHomeCardState([q({ isLoading: true, fetchStatus: 'fetching', data: undefined })], true)
        .kind
    ).toBe('loading');
    expect(resolveHomeCardState([q({ isError: true, data: undefined })], true).kind).toBe('error');
  });

  test('a failed refetch over data shows the data and an as-of footer at the older time', () => {
    const state = resolveHomeCardState(
      [q({ dataUpdatedAt: 2000 }), q({ isError: true, dataUpdatedAt: 1000 })],
      false
    );
    expect(state.kind).toBe('loaded');
    if (state.kind === 'loaded') expect(state.staleSince).toBe(1000);
  });

  test('a healthy card has no stale time', () => {
    const state = resolveHomeCardState([q(), q()], false);
    expect(state.kind === 'loaded' && state.staleSince).toBeNull();
  });

  test('a never-fetched query does not set the stale time to the epoch', () => {
    const state = resolveHomeCardState(
      [q({ data: undefined, dataUpdatedAt: 0 }), q({ isError: true, dataUpdatedAt: 5000 })],
      false
    );
    expect(state.kind === 'loaded' && state.staleSince).toBe(5000);
  });

  test('retry refetches only the failed queries', () => {
    const ok = mock(() => {});
    const failed = mock(() => {});
    const state = resolveHomeCardState(
      [q({ refetch: ok }), q({ isError: true, data: undefined, refetch: failed })],
      false
    );
    if (state.kind !== 'error') throw new Error(`expected error, got ${state.kind}`);
    state.retry();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(ok).not.toHaveBeenCalled();
  });
});
