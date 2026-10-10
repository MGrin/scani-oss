import { beforeEach, describe, expect, test } from 'bun:test';
import { _resetReturnsCache, sharedReturnsRun } from '../../src/lib/returns-cache';

// The returns run is shared across requests only while the data under it is
// unchanged. Each case below is a way the cache could answer with a stale or
// wrong result, and the version reader is injected so no database is needed.

const USER = 'user-a';
const KEY = 'returns:user-a:{"kind":"user"}:{"kind":"ytd"}';

function counter<T>(value: T) {
  let runs = 0;
  return {
    compute: async () => {
      runs += 1;
      return value;
    },
    runs: () => runs,
  };
}

const fixedVersion = (v: string) => async () => v;

beforeEach(() => _resetReturnsCache());

describe('sharedReturnsRun', () => {
  test('a second request over unchanged data shares the first run', async () => {
    const c = counter('result');
    await sharedReturnsRun(KEY, USER, c.compute, fixedVersion('v1'), '2026-09-24');
    const second = await sharedReturnsRun(KEY, USER, c.compute, fixedVersion('v1'), '2026-09-24');
    expect(second).toBe('result');
    expect(c.runs()).toBe(1);
  });

  test('a change in the data version computes again', async () => {
    // A new transaction or a fresh rollup: serving the old run here is the
    // stale answer this cache must never give.
    const c = counter('result');
    await sharedReturnsRun(KEY, USER, c.compute, fixedVersion('v1'), '2026-09-24');
    await sharedReturnsRun(KEY, USER, c.compute, fixedVersion('v2'), '2026-09-24');
    expect(c.runs()).toBe(2);
  });

  test('a new day computes again, because relative windows move with it', async () => {
    const c = counter('result');
    await sharedReturnsRun(KEY, USER, c.compute, fixedVersion('v1'), '2026-09-24');
    await sharedReturnsRun(KEY, USER, c.compute, fixedVersion('v1'), '2026-09-25');
    expect(c.runs()).toBe(2);
  });

  test('a different request key is never shared', async () => {
    // Another window or scope: one run must not print under another's axis.
    const c = counter('result');
    await sharedReturnsRun(KEY, USER, c.compute, fixedVersion('v1'), '2026-09-24');
    await sharedReturnsRun(`${KEY}:1y`, USER, c.compute, fixedVersion('v1'), '2026-09-24');
    expect(c.runs()).toBe(2);
  });

  test('concurrent callers share one in-flight run', async () => {
    const c = counter('result');
    await Promise.all([
      sharedReturnsRun(KEY, USER, c.compute, fixedVersion('v1'), '2026-09-24'),
      sharedReturnsRun(KEY, USER, c.compute, fixedVersion('v1'), '2026-09-24'),
    ]);
    expect(c.runs()).toBe(1);
  });

  test('a failed run is not served to the next caller', async () => {
    let runs = 0;
    const flaky = async () => {
      runs += 1;
      if (runs === 1) throw new Error('boom');
      return 'recovered';
    };
    await expect(
      sharedReturnsRun(KEY, USER, flaky, fixedVersion('v1'), '2026-09-24')
    ).rejects.toThrow('boom');
    const second = await sharedReturnsRun(KEY, USER, flaky, fixedVersion('v1'), '2026-09-24');
    expect(second).toBe('recovered');
    expect(runs).toBe(2);
  });

  test('windows over unchanged data are handed one data key (SC-1671)', async () => {
    const seen: string[] = [];
    const record = async (dataKey: string) => {
      seen.push(dataKey);
      return 'result';
    };
    await Promise.all([
      sharedReturnsRun(`${KEY}:all`, USER, record, fixedVersion('v1'), '2026-09-24'),
      sharedReturnsRun(`${KEY}:1y`, USER, record, fixedVersion('v1'), '2026-09-24'),
      sharedReturnsRun(`${KEY}:ytd`, USER, record, fixedVersion('v1'), '2026-09-24'),
    ]);
    expect(seen).toHaveLength(3);
    expect(new Set(seen)).toEqual(new Set(['user-a:2026-09-24:v1']));
  });

  test('a write between two calls hands the second a fresh data key (SC-1671)', async () => {
    const seen: string[] = [];
    const record = async (dataKey: string) => {
      seen.push(dataKey);
      return 'result';
    };
    await sharedReturnsRun(`${KEY}:all`, USER, record, fixedVersion('v1'), '2026-09-24');
    await sharedReturnsRun(`${KEY}:1y`, USER, record, fixedVersion('v2'), '2026-09-24');
    expect(seen).toEqual(['user-a:2026-09-24:v1', 'user-a:2026-09-24:v2']);
  });

  test("another user's windows never share a user's data key (SC-1671)", async () => {
    const seen: string[] = [];
    const record = async (dataKey: string) => {
      seen.push(dataKey);
      return 'result';
    };
    await sharedReturnsRun(`${KEY}:all`, USER, record, fixedVersion('v1'), '2026-09-24');
    await sharedReturnsRun(
      'returns:user-b:all',
      'user-b',
      record,
      fixedVersion('v1'),
      '2026-09-24'
    );
    expect(seen[0]).not.toBe(seen[1]);
  });
});
