import { describe, expect, test } from 'bun:test';
import type { Redis } from 'ioredis';
import { RedisInflowRateLimiter } from '../src/index';

interface IncrCall {
  key: string;
  amount: number;
}
interface ExpireCall {
  key: string;
  seconds: number;
}

function stubRedis(initialCounts: Record<string, number> = {}): {
  redis: Redis;
  incrCalls: IncrCall[];
  expireCalls: ExpireCall[];
} {
  const counts: Record<string, number> = { ...initialCounts };
  const incrCalls: IncrCall[] = [];
  const expireCalls: ExpireCall[] = [];
  const redis = {
    incrby: async (key: string, amount: number) => {
      incrCalls.push({ key, amount });
      counts[key] = (counts[key] ?? 0) + amount;
      return counts[key];
    },
    expire: async (key: string, seconds: number) => {
      expireCalls.push({ key, seconds });
      return 1;
    },
  };
  return { redis: redis as unknown as Redis, incrCalls, expireCalls };
}

function req(): Request {
  return new Request('http://test/', { headers: { 'cf-connecting-ip': '1.1.1.1' } });
}

describe('RedisInflowRateLimiter', () => {
  test('admits requests when count <= max', async () => {
    const { redis } = stubRedis();
    const limiter = new RedisInflowRateLimiter(redis, {
      windowMs: 60_000,
      max: 3,
      namespace: 'rl:test',
    });
    for (let i = 0; i < 3; i++) {
      const out = await limiter.tryConsume(req());
      expect(out.ok).toBe(true);
    }
  });

  test('rejects when count exceeds max', async () => {
    const { redis } = stubRedis();
    const limiter = new RedisInflowRateLimiter(redis, {
      windowMs: 60_000,
      max: 2,
      namespace: 'rl:test',
    });
    await limiter.tryConsume(req());
    await limiter.tryConsume(req());
    const out = await limiter.tryConsume(req());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.retryAfterSec).toBeGreaterThan(0);
  });

  test('builds the Redis key as <namespace>:<identity>:<windowStart>', async () => {
    const { redis, incrCalls } = stubRedis();
    const limiter = new RedisInflowRateLimiter(redis, {
      windowMs: 60_000,
      max: 100,
      namespace: 'rl:standard',
    });
    await limiter.tryConsume(req());
    expect(incrCalls[0]?.key).toMatch(/^rl:standard:1\.1\.1\.1:\d+$/);
  });

  test('sets expiry only on the first hit of a window', async () => {
    const { redis, expireCalls } = stubRedis();
    const limiter = new RedisInflowRateLimiter(redis, {
      windowMs: 60_000,
      max: 10,
      namespace: 'rl:test',
    });
    await limiter.tryConsume(req());
    await limiter.tryConsume(req());
    await limiter.tryConsume(req());
    expect(expireCalls).toHaveLength(1);
    expect(expireCalls[0]?.seconds).toBe(60);
  });

  test('honours custom token cost (incrby N)', async () => {
    const { redis, incrCalls } = stubRedis();
    const limiter = new RedisInflowRateLimiter(redis, {
      windowMs: 60_000,
      max: 100,
      namespace: 'rl:test',
    });
    await limiter.tryConsume(req(), 5);
    expect(incrCalls[0]?.amount).toBe(5);
  });
});
