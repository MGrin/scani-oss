import { afterEach, describe, expect, test } from 'bun:test';
import { setSharedRedis } from '@scani/rate-limiter';
import { createPortfolioRedisKey } from '../../../src/lib/request-cache';
import type { PortfolioValueResult } from '../../../src/services/portfolio/PortfolioValuationService';
import { PortfolioValueCache } from '../../../src/services/portfolio/PortfolioValueCache';

// Minimal in-memory Redis double — only the four commands
// PortfolioValueCache uses (get / set / scan / unlink). `scan` does a
// prefix match, which is all the `pv:<version>:<userId>:*` bust pattern needs.
function makeFakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key: string): Promise<string | null> => store.get(key) ?? null,
    set: async (key: string, value: string): Promise<'OK'> => {
      store.set(key, value);
      return 'OK';
    },
    scan: async (_cursor: string, _match: string, pattern: string): Promise<[string, string[]]> => {
      const prefix = pattern.replace(/\*$/, '');
      return ['0', [...store.keys()].filter((k) => k.startsWith(prefix))];
    },
    unlink: async (...keys: string[]): Promise<number> => {
      let removed = 0;
      for (const key of keys) if (store.delete(key)) removed++;
      return removed;
    },
  };
}

type FakeRedis = ReturnType<typeof makeFakeRedis>;

function useFakeRedis(fake: FakeRedis): void {
  setSharedRedis(fake as unknown as Parameters<typeof setSharedRedis>[0]);
}

function sampleResult(totalValue = '100'): PortfolioValueResult {
  return {
    totalValue,
    baseCurrency: 'USD',
    holdings: [
      {
        accountId: 'acc-1',
        tokenId: 'token-1',
        tokenSymbol: 'BTC',
        balance: '1',
        currentPrice: '100',
        value: '100',
        priceTimestamp: new Date('2026-05-21T00:00:00.000Z'),
        priceSource: 'coingecko',
        isActive: true,
      },
    ],
  };
}

// Let a fire-and-forget Redis write (not awaited inside getOrCompute) settle.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  setSharedRedis(null);
});

describe('PortfolioValueCache', () => {
  test('busting a user stops sharing and caching a computation begun before the mutation', async () => {
    const redis = makeFakeRedis();
    useFakeRedis(redis);
    const cache = new PortfolioValueCache();
    const key = createPortfolioRedisKey('u1', undefined, 'c1', 'v1');
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const old = cache.getOrCompute(key, async () => {
      await held;
      return sampleResult('old');
    });
    await flush();
    await cache.bust('u1');
    const current = cache.getOrCompute(key, async () => sampleResult('new'));
    release();
    expect((await current).totalValue).toBe('new');
    await old;
    await flush();
    expect(JSON.parse(redis.store.get(key)!).totalValue).toBe('new');
  });

  for (const configured of [true, false]) {
    test(`coalesces concurrent misses with Redis ${configured ? 'configured' : 'absent'}`, async () => {
      if (configured) useFakeRedis(makeFakeRedis());
      else setSharedRedis(null);
      const cache = new PortfolioValueCache();
      let calls = 0;
      const factory = async () => {
        calls++;
        await flush();
        return sampleResult('42');
      };
      const results = await Promise.all(
        Array.from({ length: 12 }, () => cache.getOrCompute('pv:v2:u1:all:c1:v1', factory))
      );
      expect(calls).toBe(1);
      expect(results.every((result) => result.totalValue === '42')).toBe(true);
    });
  }

  test('a failed computation is shared and a later request can retry', async () => {
    setSharedRedis(null);
    const cache = new PortfolioValueCache();
    let calls = 0;
    const fail = async () => {
      calls++;
      await flush();
      throw new Error('pricing unavailable');
    };
    const results = await Promise.allSettled([
      cache.getOrCompute('same', fail),
      cache.getOrCompute('same', fail),
    ]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(calls).toBe(1);
    expect((await cache.getOrCompute('same', async () => sampleResult('9'))).totalValue).toBe('9');
  });

  test('different users and versions compute independently', async () => {
    setSharedRedis(null);
    const cache = new PortfolioValueCache();
    const results = await Promise.all(
      ['u1:v1', 'u2:v1', 'u1:v2'].map((key, index) =>
        cache.getOrCompute(key, async () => sampleResult(String(index)))
      )
    );
    expect(results.map((result) => result.totalValue)).toEqual(['0', '1', '2']);
  });

  test('miss runs the factory and caches the result', async () => {
    const redis = makeFakeRedis();
    useFakeRedis(redis);
    const cache = new PortfolioValueCache();

    let calls = 0;
    const result = await cache.getOrCompute('pv:v2:u1:all:c1', async () => {
      calls++;
      return sampleResult('42');
    });

    expect(calls).toBe(1);
    expect(result.totalValue).toBe('42');
    await flush();
    expect(redis.store.has('pv:v2:u1:all:c1')).toBe(true);
  });

  test('hit returns the cached value without running the factory', async () => {
    const redis = makeFakeRedis();
    useFakeRedis(redis);
    const cache = new PortfolioValueCache();

    let calls = 0;
    const factory = async () => {
      calls++;
      return sampleResult('7');
    };

    await cache.getOrCompute('pv:v2:u1:all:c1', factory);
    await flush();
    const second = await cache.getOrCompute('pv:v2:u1:all:c1', factory);

    expect(calls).toBe(1);
    expect(second.totalValue).toBe('7');
  });

  test('revives priceTimestamp as a Date on a cache hit', async () => {
    const redis = makeFakeRedis();
    useFakeRedis(redis);
    const cache = new PortfolioValueCache();

    await cache.getOrCompute('pv:v2:u1:all:c1', async () => sampleResult());
    await flush();
    const hit = await cache.getOrCompute('pv:v2:u1:all:c1', async () => sampleResult());

    expect(hit.holdings[0]?.priceTimestamp).toBeInstanceOf(Date);
    expect(hit.holdings[0]?.priceTimestamp?.toISOString()).toBe('2026-05-21T00:00:00.000Z');
  });

  test('falls through to the factory every call when no Redis is configured', async () => {
    setSharedRedis(null);
    const cache = new PortfolioValueCache();

    let calls = 0;
    const factory = async () => {
      calls++;
      return sampleResult();
    };

    await cache.getOrCompute('pv:v2:u1:all:c1', factory);
    await cache.getOrCompute('pv:v2:u1:all:c1', factory);

    expect(calls).toBe(2);
  });

  test('bust removes every cached key for the user and leaves others', async () => {
    const redis = makeFakeRedis();
    useFakeRedis(redis);
    const cache = new PortfolioValueCache();

    const mine = createPortfolioRedisKey('u1', undefined, 'c1', 'v1');
    const minePerAccount = createPortfolioRedisKey('u1', 'acc-9', 'c1', 'v1');
    const someoneElses = createPortfolioRedisKey('u2', undefined, 'c1', 'v1');

    redis.store.set(mine, '{}');
    redis.store.set(minePerAccount, '{}');
    redis.store.set(someoneElses, '{}');

    await cache.bust('u1');

    expect(redis.store.has(mine)).toBe(false);
    expect(redis.store.has(minePerAccount)).toBe(false);
    expect(redis.store.has(someoneElses)).toBe(true);
  });

  test('bust is a no-op when no Redis is configured', async () => {
    setSharedRedis(null);
    const cache = new PortfolioValueCache();
    await expect(cache.bust('u1')).resolves.toBeUndefined();
  });
});
