import { describe, expect, test } from 'bun:test';
import type { Redis } from 'ioredis';
import { InMemoryOutflowRateLimiter, RedisOutflowRateLimiter } from '../src/index';

/**
 * SC-1766. A `high` caller (a user's search) goes ahead of `normal` ones
 * (background price calls) inside ONE budget. The cap is the property to
 * keep: SC-1706 spaced keyless CoinGecko to one call every 6 s, and a second
 * budget beside it would have let the two add up.
 */

const WINDOW = 300;

describe('outflow priority (SC-1766)', () => {
  test('high and normal callers together never exceed one call per window', async () => {
    const limiter = new InMemoryOutflowRateLimiter(1, WINDOW);
    const grants: number[] = [];
    const call = (priority: 'normal' | 'high') =>
      limiter.execute(
        async () => {
          grants.push(performance.now());
        },
        undefined,
        undefined,
        priority
      );
    await Promise.all([
      call('normal'),
      call('high'),
      call('normal'),
      call('high'),
      call('normal'),
      call('high'),
    ]);
    grants.sort((a, b) => a - b);
    expect(grants).toHaveLength(6);
    for (let i = 1; i < grants.length; i++) {
      // Timers fire late, never early; 5 ms covers clock rounding.
      expect((grants[i] as number) - (grants[i - 1] as number)).toBeGreaterThanOrEqual(WINDOW - 5);
    }
  });

  test('a high caller that arrives later is served before every waiting normal one', async () => {
    // Five background calls already waiting: without priority the search
    // would win the race one time in six, so three trials leave a lucky pass
    // one chance in 216.
    for (let trial = 0; trial < 3; trial++) {
      const limiter = new InMemoryOutflowRateLimiter(1, 150);
      const order: string[] = [];
      await limiter.execute(async () => order.push('first'));
      const background = [1, 2, 3, 4, 5].map((n) =>
        limiter.execute(async () => order.push(`background-${n}`))
      );
      await Bun.sleep(30);
      const search = limiter.execute(
        async () => order.push('search'),
        undefined,
        undefined,
        'high'
      );
      await Promise.all([...background, search]);
      expect(order.slice(0, 2)).toEqual(['first', 'search']);
    }
  });

  test('control: with no high caller, normal callers are served in turn', async () => {
    const limiter = new InMemoryOutflowRateLimiter(1, WINDOW);
    const order: string[] = [];
    await Promise.all([
      limiter.execute(async () => order.push('a')),
      Bun.sleep(20).then(() => limiter.execute(async () => order.push('b'))),
    ]);
    expect(order).toEqual(['a', 'b']);
  });

  test('a high caller that gave up stops holding normal callers back', async () => {
    const limiter = new InMemoryOutflowRateLimiter(1, WINDOW);
    await limiter.execute(async () => {});
    const gaveUp = limiter.execute(async () => {}, undefined, AbortSignal.timeout(50), 'high');
    await expect(gaveUp).rejects.toThrow();
    const started = performance.now();
    await limiter.execute(async () => {});
    // The claim lapses one window plus a second after the high caller's last ask.
    expect(performance.now() - started).toBeLessThan(WINDOW + 1000 + 500);
  });
});

describe('RedisOutflowRateLimiter priority arguments (SC-1766)', () => {
  function stub() {
    const calls: string[][] = [];
    const redis = {
      eval: async (_script: string, numKeys: number, ...args: string[]) => {
        calls.push([String(numKeys), ...args]);
        return 0;
      },
    } as unknown as Redis;
    return { redis, calls };
  }

  test('both priorities read the same window key; a high caller names itself', async () => {
    const { redis, calls } = stub();
    const limiter = new RedisOutflowRateLimiter({
      redis,
      namespace: 'coingecko',
      maxRequests: 1,
      windowMs: 6000,
    });
    await limiter.execute(async () => {});
    await limiter.execute(async () => {}, undefined, undefined, 'high');
    const [normal, high] = calls;
    expect(normal?.slice(0, 3)).toEqual(['2', 'rl:coingecko', 'rl:coingecko:priority']);
    expect(high?.slice(0, 3)).toEqual(['2', 'rl:coingecko', 'rl:coingecko:priority']);
    expect(normal?.[6]).toBe('');
    expect(high?.[6]).not.toBe('');
  });
});
