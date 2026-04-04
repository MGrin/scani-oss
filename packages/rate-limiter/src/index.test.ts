import { describe, expect, it } from 'bun:test';
import { RateLimiter } from './index';

describe('RateLimiter', () => {
  it('should execute a function immediately when under limit', async () => {
    const limiter = new RateLimiter(10, 1000);
    const result = await limiter.execute(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('should execute multiple calls within limit', async () => {
    const limiter = new RateLimiter(5, 1000);
    const results: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await limiter.execute(() => Promise.resolve(i));
      results.push(r);
    }
    expect(results).toEqual([0, 1, 2, 3, 4]);
  });

  it('should propagate errors from executed function', async () => {
    const limiter = new RateLimiter(10, 1000);
    expect(limiter.execute(() => Promise.reject(new Error('test error')))).rejects.toThrow(
      'test error'
    );
  });

  it('should handle concurrent calls', async () => {
    const limiter = new RateLimiter(3, 100);
    const promises = Array.from({ length: 3 }, (_, i) => limiter.execute(() => Promise.resolve(i)));
    const results = await Promise.all(promises);
    expect(results).toEqual([0, 1, 2]);
  });

  it('should queue calls when exceeding rate limit', async () => {
    const limiter = new RateLimiter(2, 200);
    const start = Date.now();

    // Execute 4 calls with limit of 2 per 200ms
    const promises = Array.from({ length: 4 }, (_, i) => limiter.execute(() => Promise.resolve(i)));
    const results = await Promise.all(promises);

    // All should complete
    expect(results).toEqual([0, 1, 2, 3]);

    // Should have taken at least 200ms (one window for overflow)
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(150); // Allow some tolerance
  });
});
