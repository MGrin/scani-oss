import { afterAll, describe, expect, test } from 'bun:test';
import Redis from 'ioredis';
import { GlobalCostBreaker } from '../../src/usage/global-cost-breaker';

/**
 * SC-1027. The breaker promises to fail OPEN when Redis is down, and its
 * `catch` is what does it — but the shared client is built exactly as below,
 * `maxRetriesPerRequest: null`, which never rejects a command issued while the
 * connection is down. Measured before the bound: `shouldAllow()` still pending
 * after 4000ms, so every metered request hung in the middleware.
 *
 * Nothing listens on port 1, so the connection is refused on every retry.
 */
const clients: Redis[] = [];
function deadRedis(): Redis {
  const redis = new Redis('redis://127.0.0.1:1', { maxRetriesPerRequest: null });
  redis.on('error', () => undefined);
  clients.push(redis);
  return redis;
}

afterAll(() => {
  for (const redis of clients) redis.disconnect();
});

const PENDING = Symbol('pending');
async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof PENDING> {
  return Promise.race([work, new Promise<typeof PENDING>((r) => setTimeout(() => r(PENDING), ms))]);
}

describe('GlobalCostBreaker against an unreachable Redis (SC-1027)', () => {
  test('the pre-flight fails open inside its bound instead of hanging', async () => {
    const breaker = new GlobalCostBreaker(deadRedis(), { hourlyUsdCap: 5 });
    const started = performance.now();
    expect(await within(breaker.shouldAllow(), 2000)).toEqual({ ok: true });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test('recording a cost is best-effort inside its bound', async () => {
    const breaker = new GlobalCostBreaker(deadRedis(), { hourlyUsdCap: 5 });
    const started = performance.now();
    expect(await within(breaker.record(0.25), 2000)).toBe(0);
    expect(performance.now() - started).toBeLessThan(1500);
  });

  test('the control: the client itself still never answers, so the bound is what fails open', async () => {
    expect(await within(deadRedis().get('global:cost:hour:0'), 1000)).toBe(PENDING);
  });
});
