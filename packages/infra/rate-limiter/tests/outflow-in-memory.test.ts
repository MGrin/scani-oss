import { describe, expect, test } from 'bun:test';
import { InMemoryOutflowRateLimiter } from '../src/index';

describe('InMemoryOutflowRateLimiter', () => {
  test('runs a single call immediately when under the limit', async () => {
    const limiter = new InMemoryOutflowRateLimiter(10, 1000);
    const result = await limiter.execute(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  test('runs N calls in sequence when N <= max within the window', async () => {
    const limiter = new InMemoryOutflowRateLimiter(5, 1000);
    const results: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await limiter.execute(() => Promise.resolve(i));
      results.push(r);
    }
    expect(results).toEqual([0, 1, 2, 3, 4]);
  });

  test('propagates errors from the wrapped function', async () => {
    const limiter = new InMemoryOutflowRateLimiter(10, 1000);
    await expect(limiter.execute(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });

  test('handles concurrent calls under the limit', async () => {
    const limiter = new InMemoryOutflowRateLimiter(3, 100);
    const results = await Promise.all(
      [0, 1, 2].map((i) => limiter.execute(() => Promise.resolve(i)))
    );
    expect(results.sort()).toEqual([0, 1, 2]);
  });

  test('queues calls when the window is full and lets them through later', async () => {
    const limiter = new InMemoryOutflowRateLimiter(2, 200);
    const start = Date.now();
    const results = await Promise.all(
      [0, 1, 2, 3].map((i) => limiter.execute(() => Promise.resolve(i)))
    );
    const elapsed = Date.now() - start;

    expect(results.sort()).toEqual([0, 1, 2, 3]);
    // The 3rd and 4th calls had to wait for the window to slide, so total
    // time should be at least the window length (200ms) minus a generous
    // tolerance for setTimeout drift.
    expect(elapsed).toBeGreaterThanOrEqual(150);
  });

  test('partitions buckets by subKey — independent windows per credential', async () => {
    // 1 request per 200ms — but two distinct buckets each get their own.
    const limiter = new InMemoryOutflowRateLimiter(1, 200);
    const start = Date.now();
    await Promise.all([
      limiter.execute(() => Promise.resolve('a'), 'user-a'),
      limiter.execute(() => Promise.resolve('b'), 'user-b'),
    ]);
    expect(Date.now() - start).toBeLessThan(150);
  });
});
