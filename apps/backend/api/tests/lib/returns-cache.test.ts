import { beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
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

  test('unchanged data hours later still shares the run (SC-1745)', async () => {
    // The key already moves with the data and the day. A clock on top of it
    // only made a Home load after a coffee break pay the whole cold cost.
    const c = counter('result');
    setSystemTime(new Date('2026-09-24T08:00:00.000Z'));
    try {
      await sharedReturnsRun(KEY, USER, c.compute, fixedVersion('v1'), '2026-09-24');
      setSystemTime(new Date('2026-09-24T20:00:00.000Z'));
      await sharedReturnsRun(KEY, USER, c.compute, fixedVersion('v1'), '2026-09-24');
    } finally {
      setSystemTime();
    }
    expect(c.runs()).toBe(1);
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

describe('sharedReturnsRun observation (SC-1745)', () => {
  test('reports a miss, then a hit, with the version read timed each time', async () => {
    const seen: Array<{ hit: boolean; versionMs: number }> = [];
    const c = counter('result');
    const slowVersion = async () => {
      await Bun.sleep(20);
      return 'v1';
    };
    const observe = (o: { hit: boolean; versionMs: number }) => seen.push(o);
    await sharedReturnsRun(KEY, USER, c.compute, slowVersion, '2026-09-24', observe);
    await sharedReturnsRun(KEY, USER, c.compute, slowVersion, '2026-09-24', observe);
    expect(seen.map((o) => o.hit)).toEqual([false, true]);
    for (const o of seen) expect(o.versionMs).toBeGreaterThanOrEqual(15);
  });
});

// SC-1745: each API process kept its own cache, and the worker precomputes
// Home's answers into one both machines read. A process that has not run a
// window yet serves the stored answer instead of computing it.
describe('sharedReturnsRun with the shared answer store (SC-1745)', () => {
  function store(initial: Record<string, unknown> = {}) {
    const map = new Map<string, unknown>(Object.entries(initial));
    return {
      get: async (key: string) => map.get(key) as never,
      set: async (key: string, value: unknown) => {
        map.set(key, value);
      },
      map,
    };
  }
  const FULL = `${KEY}:user-a:2026-09-24:v1`;

  test('an answer the worker stored is served without computing', async () => {
    const c = counter('fresh');
    const seen: Array<{ hit: boolean; shared?: boolean }> = [];
    const s = store({ [FULL]: 'stored' });
    const out = await sharedReturnsRun(
      KEY,
      USER,
      c.compute,
      fixedVersion('v1'),
      '2026-09-24',
      (o) => seen.push(o),
      s
    );
    expect(out).toBe('stored' as never);
    expect(c.runs()).toBe(0);
    expect(seen).toEqual([{ hit: true, shared: true, versionMs: expect.any(Number) } as never]);
  });

  test('a computed answer is stored for the other machine', async () => {
    const c = counter('fresh');
    const s = store();
    await sharedReturnsRun(KEY, USER, c.compute, fixedVersion('v1'), '2026-09-24', undefined, s);
    await Bun.sleep(0);
    expect(s.map.get(FULL)).toBe('fresh');
  });

  test('CONTROL: an answer stored under an older version is not served', async () => {
    const c = counter('fresh');
    const s = store({ [`${KEY}:user-a:2026-09-24:v0`]: 'stale' });
    const out = await sharedReturnsRun(
      KEY,
      USER,
      c.compute,
      fixedVersion('v1'),
      '2026-09-24',
      undefined,
      s
    );
    expect(out).toBe('fresh');
    expect(c.runs()).toBe(1);
  });
});
