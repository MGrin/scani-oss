import { describe, expect, test } from 'bun:test';
import type { Redis } from 'ioredis';
import { RedisOutflowRateLimiter } from '../src/index';

interface EvalCall {
  script: string;
  numKeys: number;
  args: string[];
}

function stubRedis(responses: Array<number | string>): { redis: Redis; calls: EvalCall[] } {
  const calls: EvalCall[] = [];
  let i = 0;
  const redis = {
    eval: async (script: string, numKeys: number, ...args: string[]) => {
      calls.push({ script, numKeys, args });
      const next = responses[i++] ?? 0;
      return next;
    },
  };
  return { redis: redis as unknown as Redis, calls };
}

describe('RedisOutflowRateLimiter', () => {
  test('grants a slot on first call and runs the wrapped function', async () => {
    const { redis, calls } = stubRedis([0]);
    const limiter = new RedisOutflowRateLimiter({
      redis,
      namespace: 'coingecko',
      maxRequests: 10,
      windowMs: 1000,
    });

    const result = await limiter.execute(() => Promise.resolve('ok'));
    expect(result).toBe('ok');
    expect(calls).toHaveLength(1);
  });

  test('uses the namespace as the Redis key when no subKey given', async () => {
    const { redis, calls } = stubRedis([0]);
    const limiter = new RedisOutflowRateLimiter({
      redis,
      namespace: 'etherscan',
      maxRequests: 5,
      windowMs: 1000,
    });
    await limiter.execute(() => Promise.resolve('x'));
    // The script's KEY is the second arg after numKeys.
    expect(calls[0]?.args[0]).toBe('rl:etherscan');
  });

  test('partitions the Redis key by subKey — independent windows per credential', async () => {
    const { redis, calls } = stubRedis([0, 0]);
    const limiter = new RedisOutflowRateLimiter({
      redis,
      namespace: 'kraken',
      maxRequests: 10,
      windowMs: 1000,
    });
    await limiter.execute(() => Promise.resolve(1), 'user-a');
    await limiter.execute(() => Promise.resolve(2), 'user-b');
    expect(calls[0]?.args[0]).toBe('rl:kraken:user-a');
    expect(calls[1]?.args[0]).toBe('rl:kraken:user-b');
  });

  test('passes maxRequests + windowMs into the Lua script as ARGV', async () => {
    const { redis, calls } = stubRedis([0]);
    const limiter = new RedisOutflowRateLimiter({
      redis,
      namespace: 'finnhub',
      maxRequests: 50,
      windowMs: 60_000,
    });
    await limiter.execute(() => Promise.resolve('x'));
    // ARGV[1] = nowMs, ARGV[2] = windowMs, ARGV[3] = max
    expect(calls[0]?.args[2]).toBe('60000');
    expect(calls[0]?.args[3]).toBe('50');
  });

  test('blocks until the script signals 0 (slot acquired)', async () => {
    // First eval returns 30ms wait; second returns 0 (slot acquired).
    const { redis, calls } = stubRedis([30, 0]);
    const limiter = new RedisOutflowRateLimiter({
      redis,
      namespace: 'busy',
      maxRequests: 1,
      windowMs: 1000,
    });
    const start = Date.now();
    await limiter.execute(() => Promise.resolve('done'));
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(25); // at least the wait we asked for
    expect(calls).toHaveLength(2);
  });

  test('handles string-typed Redis responses (some clients return numbers as strings)', async () => {
    const { redis, calls } = stubRedis(['0']);
    const limiter = new RedisOutflowRateLimiter({
      redis,
      namespace: 'ns',
      maxRequests: 1,
      windowMs: 100,
    });
    await limiter.execute(() => Promise.resolve('x'));
    expect(calls).toHaveLength(1);
  });

  test('propagates errors from the wrapped function after the slot is acquired', async () => {
    const { redis } = stubRedis([0]);
    const limiter = new RedisOutflowRateLimiter({
      redis,
      namespace: 'ns',
      maxRequests: 1,
      windowMs: 100,
    });
    await expect(limiter.execute(() => Promise.reject(new Error('upstream 500')))).rejects.toThrow(
      'upstream 500'
    );
  });
});
