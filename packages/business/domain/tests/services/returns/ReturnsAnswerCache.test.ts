import { describe, expect, test } from 'bun:test';
import {
  answerTtlSeconds,
  HOME_RETURNS_WINDOWS,
  precomputeHomeReturns,
  type ReturnsAnswerStore,
  type ReturnsPrecomputeDeps,
  returnsDataKey,
  returnsLatestKey,
  returnsLatestKeyFor,
  returnsRequestKey,
} from '../../../src/services/returns/ReturnsAnswerCache';
import type { ReturnsOutcome } from '../../../src/services/returns/ReturnsService';

// SC-1745: Home's returns are computed by the worker after the writes that
// move the user's data version, and stored where the API reads first. These
// pin the two halves to one key, and the bounds the operator set.

const USER = 'user-a';
const OK = { status: 'ok', returns: { marker: 'answer' } } as unknown as ReturnsOutcome;

function memoryStore(): ReturnsAnswerStore & { keys: () => string[] } {
  const map = new Map<string, ReturnsOutcome>();
  return {
    get: async (key) => map.get(key),
    set: async (key, outcome) => {
      map.set(key, outcome);
    },
    keys: () => [...map.keys()].sort(),
  };
}

function deps(overrides: Partial<ReturnsPrecomputeDeps> = {}) {
  const store = memoryStore();
  const computed: string[] = [];
  const all: ReturnsPrecomputeDeps = {
    store,
    isActive: async () => true,
    readVersion: async () => 'v1',
    compute: async (request) => {
      computed.push(request.window.kind);
      return OK;
    },
    today: () => '2026-10-27',
    ...overrides,
  };
  return { all, store, computed };
}

describe('precomputeHomeReturns (SC-1745)', () => {
  test('stores all, 1y and ytd under the key the API reads for a Home load', async () => {
    const { all, store, computed } = deps();
    const outcome = await precomputeHomeReturns(USER, all);

    expect(outcome).toEqual({ computed: 3, alreadyStored: 0 });
    expect(computed).toEqual(['all', '1y', 'ytd']);
    // The API builds this key from a Home request with no scope given.
    const apiKey = (kind: 'all' | '1y' | 'ytd') =>
      `${returnsRequestKey({ userId: USER, scope: { kind: 'user' }, window: { kind } })}:${returnsDataKey(USER, 'v1', '2026-10-27')}`;
    const latest = (kind: 'all' | '1y' | 'ytd') =>
      returnsLatestKey(
        returnsRequestKey({ userId: USER, scope: { kind: 'user' }, window: { kind } })
      );
    expect(store.keys()).toEqual(
      [
        apiKey('1y'),
        apiKey('all'),
        apiKey('ytd'),
        latest('1y'),
        latest('all'),
        latest('ytd'),
      ].sort()
    );
    expect(await store.get(apiKey('all'))).toBe(OK);
  });

  test('each window it computes becomes the answer Home is shown while the next is computed', async () => {
    const { all, store } = deps();
    await precomputeHomeReturns(USER, all);
    for (const window of HOME_RETURNS_WINDOWS) {
      const requestKey = returnsRequestKey({ userId: USER, scope: { kind: 'user' }, window });
      expect(await store.get(returnsLatestKey(requestKey))).toBe(OK);
    }
  });

  test('a window already stored still becomes the latest answer', async () => {
    const { all, store } = deps();
    const requestKey = returnsRequestKey({
      userId: USER,
      scope: { kind: 'user' },
      window: { kind: 'all' },
    });
    await store.set(`${requestKey}:${returnsDataKey(USER, 'v1', '2026-10-27')}`, OK);
    await precomputeHomeReturns(USER, all);
    expect(await store.get(returnsLatestKey(requestKey))).toBe(OK);
  });

  test('a second run over the same data computes nothing', async () => {
    const { all, computed } = deps();
    await precomputeHomeReturns(USER, all);
    const second = await precomputeHomeReturns(USER, all);
    expect(second).toEqual({ computed: 0, alreadyStored: 3 });
    expect(computed).toHaveLength(3);
  });

  test('a moved version computes again, under the new key', async () => {
    let version = 'v1';
    const { all, store, computed } = deps({ readVersion: async () => version });
    await precomputeHomeReturns(USER, all);
    version = 'v2';
    await precomputeHomeReturns(USER, all);
    expect(computed).toHaveLength(6);
    expect(store.keys().filter((k) => k.endsWith(':v2'))).toHaveLength(3);
  });

  test('a user who has not opened the app in 14 days gets nothing computed', async () => {
    const { all, store, computed } = deps({ isActive: async () => false });
    const outcome = await precomputeHomeReturns(USER, all);
    expect(outcome.skipped).toBe('inactive');
    expect(computed).toEqual([]);
    expect(store.keys()).toEqual([]);
  });

  test('an answer that is not ok is not stored', async () => {
    const { all, store } = deps({
      compute: async () => ({ status: 'no-base-currency' }) as ReturnsOutcome,
    });
    await precomputeHomeReturns(USER, all);
    expect(store.keys()).toEqual([]);
  });

  test('CONTROL: Home asks for exactly these windows', () => {
    expect(HOME_RETURNS_WINDOWS.map((w) => w.kind)).toEqual(['all', '1y', 'ytd']);
  });
});

// SC-1776: the hero's windows are `custom` and move every day, so their latest
// answer, keyed by date, was never found on the next day's first read: a cold
// compute on production. Kept by length instead, as SC-1694's last complete is.
describe('returnsLatestKeyFor (SC-1776)', () => {
  const user = { kind: 'user' as const };
  const custom = (from: string, to: string) => ({
    userId: USER,
    scope: user,
    window: { kind: 'custom' as const, from: new Date(from), to: new Date(to) },
  });

  test('the same period a day later finds the same latest answer', () => {
    expect(returnsLatestKeyFor(custom('2026-09-27', '2026-10-27'))).toBe(
      returnsLatestKeyFor(custom('2026-09-28', '2026-10-28'))
    );
  });

  test('CONTROL: another period length is another answer', () => {
    expect(returnsLatestKeyFor(custom('2026-09-27', '2026-10-27'))).not.toBe(
      returnsLatestKeyFor(custom('2026-07-27', '2026-10-27'))
    );
  });

  test('another scope or user is never shared', () => {
    const a = custom('2026-09-27', '2026-10-27');
    expect(returnsLatestKeyFor({ ...a, userId: 'user-b' })).not.toBe(returnsLatestKeyFor(a));
    expect(returnsLatestKeyFor({ ...a, scope: { kind: 'account', id: 'x' } })).not.toBe(
      returnsLatestKeyFor(a)
    );
  });

  test('a named window keeps the key the precompute writes', () => {
    const request = { userId: USER, scope: user, window: { kind: 'ytd' as const } };
    expect(returnsLatestKeyFor(request)).toBe(returnsLatestKey(returnsRequestKey(request)));
  });

  test('a latest answer outlives a day; an answer under a version does not', () => {
    expect(answerTtlSeconds(returnsLatestKey('returns:u:x'))).toBe(7 * 24 * 60 * 60);
    expect(answerTtlSeconds('returns:u:x:u:2026-10-27:v1')).toBe(24 * 60 * 60);
  });
});
