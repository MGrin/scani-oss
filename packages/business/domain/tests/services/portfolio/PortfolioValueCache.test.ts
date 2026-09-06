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

    // Derived, never spelled. The builder and `bust`'s SCAN pattern are two
    // statements of one keyspace, and a fixture spelling the version out is a
    // THIRD — so bumping the version (SC-1114 bumped it to v2) reddened this
    // test for a reason that had nothing to do with what it asserts. Deriving
    // it also makes the test a guard that the two agree: a builder and a bust
    // that disagree now fail here rather than leaking keys in production.
    const mine = createPortfolioRedisKey('u1', undefined, 'c1');
    const minePerAccount = createPortfolioRedisKey('u1', 'acc-9', 'c1');
    const someoneElses = createPortfolioRedisKey('u2', undefined, 'c1');

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
