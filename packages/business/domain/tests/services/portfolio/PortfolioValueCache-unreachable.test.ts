import { afterEach, describe, expect, test } from 'bun:test';
import { setSharedRedis } from '@scani/rate-limiter';
import type { PortfolioValueResult } from '../../../src/services/portfolio/PortfolioValuationService';
import { PortfolioValueCache } from '../../../src/services/portfolio/PortfolioValueCache';

/**
 * SC-522. A Redis that never answers must not hold the request.
 *
 * **The production failure this pins.** `holdings.getWithDetails` reaches this
 * cache on every load of the portfolio page. The api's shared client is built
 * `{ maxRetriesPerRequest: null }` — once BullMQ's requirement, still set now
 * that the queue is on Postgres (SC-518) —
 * and ioredis 5.10.1 only flushes its offline queue `if (typeof
 * maxRetriesPerRequest === "number")`, so a command issued while the
 * connection is down is never rejected. The `try/catch` around the read was
 * therefore not a degraded path but a hang wearing one: the catch could not
 * run, because nothing ever rejected.
 *
 * Measured 2026-08-21 against the real api on real containers, stopping the
 * Redis container mid-flight rather than stubbing anything:
 *
 *     GET /health                        -> 200 in 1.4ms
 *     GET /readyz                        -> NO RESPONSE, curl gave up at 30s
 *     PortfolioValueCache.getOrCompute   -> HUNG for its full 15000ms budget
 *     PortfolioValueCache.bust           -> HUNG for its full 10000ms budget
 *
 * A liveness probe answering 200 over a request path that will never return is
 * the defect; the strand that triggers it is ordinary and expected (Redis
 * lives inside the worker machine, so any worker restart causes it).
 *
 * The doubles below are that exact shape — a command that never settles. They
 * model the failing dependency, not the fix, and against the unbounded
 * implementation every test in the first describe block hangs until bun's
 * timeout kills it.
 */

function sampleResult(totalValue = '100'): PortfolioValueResult {
  return { totalValue, baseCurrency: 'USD', holdings: [] };
}

function useRedis(fake: Record<string, unknown>): void {
  setSharedRedis(fake as unknown as Parameters<typeof setSharedRedis>[0]);
}

/** A Redis whose commands never settle — the api's client on a dead host. */
const never = () => new Promise<never>(() => {});

/** A Redis that rejects rather than hangs — the same outage seen through a
 *  connection that does bound its retries. Both shapes must degrade alike. */
const boom = () => Promise.reject(new Error('getaddrinfo ENOTFOUND'));

/** Answers, but takes `ms` to do it. Used on both sides of the bound. */
function slow<T>(value: T, ms: number) {
  return () => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
}

// `setSharedRedis` is process-global and `bun test` runs every file in one
// process, so a double left behind here is what the next file resolves.
afterEach(() => {
  setSharedRedis(null);
});

describe('an unreachable Redis degrades instead of hanging', () => {
  test('THE DEFECT: getOrCompute returns the computed value when the read never settles', async () => {
    useRedis({ get: never, set: never, scan: never, unlink: never });
    const cache = new PortfolioValueCache();

    const started = performance.now();
    const result = await cache.getOrCompute('pv:v1:u1:all:c1', async () => sampleResult('42'));

    expect(result.totalValue).toBe('42');
    // 8x the cache's own 250ms deadline: loose enough that a saturated box
    // cannot flake it, and tight enough to fire BEFORE bun's 5s per-test
    // timeout — so the failure a future regression produces is this
    // assertion, naming the bound, rather than a bare "timed out".
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test('a rejecting read degrades the same way as a hanging one', async () => {
    useRedis({ get: boom, set: boom, scan: boom, unlink: boom });
    const cache = new PortfolioValueCache();

    const result = await cache.getOrCompute('pv:v1:u1:all:c1', async () => sampleResult('42'));

    expect(result.totalValue).toBe('42');
  });

  test('THE DEFECT: bust returns when SCAN never settles', async () => {
    // `enqueuePortfolioRollup` awaits this on the api's MUTATION path, so an
    // unbounded SCAN hangs the user's write, not just their read.
    useRedis({ get: never, set: never, scan: never, unlink: never });
    const cache = new PortfolioValueCache();

    const started = performance.now();
    await cache.bust('u1');

    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test('THE DEFECT: bust returns when SCAN answers but UNLINK never settles', async () => {
    // A half-answering Redis is not hypothetical: the strand is per-command,
    // and bounding only the first command in the loop would leave this one
    // hanging while every test above still passed.
    useRedis({
      get: never,
      set: never,
      scan: async () => ['0', ['pv:v1:u1:all:c1']] as [string, string[]],
      unlink: never,
    });
    const cache = new PortfolioValueCache();

    const started = performance.now();
    await cache.bust('u1');

    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

/**
 * **Do not delete this block.** It looks like it tests nothing — "a working
 * cache works" — and that is exactly why it has to be here.
 *
 * The bug being fixed is a request path that hangs on a dead dependency behind
 * a health check that cannot see it. The obvious fix for that is a timeout,
 * and a timeout is a *discriminator*: it has to fire on the failure and stay
 * silent on the benign case that shares its signal. The benign case here is a
 * Redis that is alive and merely slower than instant — under load, on a
 * saturated box, on a large portfolio payload. If the bound fires there, every
 * request recomputes the full valuation, which is precisely the CPU saturation
 * this cache exists to prevent. That is a worse outage than the one being
 * fixed, and no test in the block above can tell the two apart, because a
 * timeout that fires on everything passes all of them.
 *
 * So the load-bearing evidence is not `HUNG -> degraded`. It is that a live
 * Redis is still served from, and still bust, unchanged.
 */
describe('a healthy Redis is still used — the case a wrong bound would break', () => {
  test('a cache hit is still served from Redis, not recomputed', async () => {
    const cached = JSON.stringify(sampleResult('999'));
    useRedis({ get: async () => cached, set: async () => 'OK' });
    const cache = new PortfolioValueCache();

    let factoryCalls = 0;
    const result = await cache.getOrCompute('pv:v1:u1:all:c1', async () => {
      factoryCalls++;
      return sampleResult('1');
    });

    expect(result.totalValue).toBe('999');
    expect(factoryCalls).toBe(0);
  });

  test('a slow-but-alive Redis inside the bound is still a HIT, not a timeout', async () => {
    // 100ms against a 250ms bound: far slower than production's ~1ms, and
    // still served. Shrink the bound below this and the assertion below flips
    // to a recompute — which is the regression this test exists to catch.
    const cached = JSON.stringify(sampleResult('999'));
    useRedis({ get: slow(cached, 100), set: async () => 'OK' });
    const cache = new PortfolioValueCache();

    let factoryCalls = 0;
    const result = await cache.getOrCompute('pv:v1:u1:all:c1', async () => {
      factoryCalls++;
      return sampleResult('1');
    });

    expect(result.totalValue).toBe('999');
    expect(factoryCalls).toBe(0);
  });

  test('bust still unlinks the keys a live Redis reports', async () => {
    const unlinked: string[] = [];
    useRedis({
      scan: async () => ['0', ['pv:v1:u1:all:c1', 'pv:v1:u1:acc-9:c1']] as [string, string[]],
      unlink: async (...keys: string[]) => {
        unlinked.push(...keys);
        return keys.length;
      },
    });
    const cache = new PortfolioValueCache();

    await cache.bust('u1');

    expect(unlinked).toEqual(['pv:v1:u1:all:c1', 'pv:v1:u1:acc-9:c1']);
  });

  test('bust still walks every SCAN page — the bound is per command, not per bust', async () => {
    // A multi-page bust takes N x the per-command bound in the worst case. If
    // someone later moves the timeout to wrap the whole loop, this is the test
    // that notices, because page two would be cut off mid-walk.
    const pages: Array<[string, string[]]> = [
      ['7', ['pv:v1:u1:a:c1']],
      ['0', ['pv:v1:u1:b:c1']],
    ];
    let page = 0;
    const unlinked: string[] = [];
    useRedis({
      scan: async () => pages[page++] as [string, string[]],
      unlink: async (...keys: string[]) => {
        unlinked.push(...keys);
        return keys.length;
      },
    });
    const cache = new PortfolioValueCache();

    await cache.bust('u1');

    expect(unlinked).toEqual(['pv:v1:u1:a:c1', 'pv:v1:u1:b:c1']);
  });
});
