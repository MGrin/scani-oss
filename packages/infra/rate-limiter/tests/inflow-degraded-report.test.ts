import { afterEach, describe, expect, test } from 'bun:test';
import type { Redis } from 'ioredis';
import {
  type InflowDegradedReport,
  RedisInflowRateLimiter,
  setInflowDegradedHandler,
} from '../src/index';

/**
 * The degraded path must be audible (SC-489).
 *
 * `inflow-redis-unreachable.test.ts` pins that a limiter whose Redis is gone
 * still admits the request. This pins the other half: that it says so. Without
 * it, a slow Redis silently restarts the count and multiplies the cap by the
 * number of processes counting — and the only symptom is a rate-limit
 * assertion failing somewhere with no explanation available anywhere.
 */
function hangingRedis(): Redis {
  return {
    incrby: () => new Promise(() => {}),
    expire: () => new Promise(() => {}),
  } as unknown as Redis;
}

afterEach(() => setInflowDegradedHandler(null));

describe('RedisInflowRateLimiter degraded reporting', () => {
  test('reports the fallback, with the namespace and the reason', async () => {
    const reports: InflowDegradedReport[] = [];
    setInflowDegradedHandler((report) => reports.push(report));

    const limiter = new RedisInflowRateLimiter(hangingRedis(), {
      windowMs: 60_000,
      max: 10,
      namespace: 'rl:test',
      timeoutMs: 5,
    });

    await limiter.tryConsumeKey('someone');

    expect(reports).toHaveLength(1);
    expect(reports[0]?.namespace).toBe('rl:test');
    expect(reports[0]?.timeoutMs).toBe(5);
    expect(reports[0]?.count).toBe(1);
    expect(String((reports[0]?.error as Error)?.message)).toContain('did not answer');
  });

  test('an outage reports once, not once per request', async () => {
    const reports: InflowDegradedReport[] = [];
    setInflowDegradedHandler((report) => reports.push(report));

    const limiter = new RedisInflowRateLimiter(hangingRedis(), {
      windowMs: 60_000,
      max: 100,
      namespace: 'rl:test',
      timeoutMs: 5,
    });

    for (let i = 0; i < 5; i++) await limiter.tryConsumeKey('someone');

    // The first is immediate; the rest are inside the 10s report interval and
    // are carried as a count on the next report rather than logged five times.
    expect(reports).toHaveLength(1);
  });

  test('a throwing handler cannot fail the request it was reporting on', async () => {
    setInflowDegradedHandler(() => {
      throw new Error('logger exploded');
    });

    const limiter = new RedisInflowRateLimiter(hangingRedis(), {
      windowMs: 60_000,
      max: 10,
      namespace: 'rl:test',
      timeoutMs: 5,
    });

    expect(await limiter.tryConsumeKey('someone')).toEqual({ ok: true });
  });
});
