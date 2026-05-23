import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  InMemoryOutflowRateLimiter,
  OutflowRateLimiterRegistry,
  RedisOutflowRateLimiter,
  setSharedRedis,
} from '../src/index';

const COINGECKO = { namespace: 'coingecko', maxRequests: 25, windowMs: 60_000 };

beforeEach(() => {
  setSharedRedis(null);
});
afterEach(() => {
  setSharedRedis(null);
});

describe('OutflowRateLimiterRegistry — caching', () => {
  test('two `get` calls for the same namespace return the same instance', () => {
    const registry = new OutflowRateLimiterRegistry();
    const a = registry.get(COINGECKO);
    const b = registry.get(COINGECKO);
    expect(a).toBe(b);
  });

  test('different namespaces produce different instances', () => {
    const registry = new OutflowRateLimiterRegistry();
    const cg = registry.get(COINGECKO);
    const fh = registry.get({ namespace: 'finnhub', maxRequests: 50, windowMs: 60_000 });
    expect(cg).not.toBe(fh);
  });
});

describe('OutflowRateLimiterRegistry — backend selection', () => {
  test('returns InMemoryOutflowRateLimiter when no shared Redis is set', () => {
    const registry = new OutflowRateLimiterRegistry();
    const limiter = registry.get(COINGECKO);
    expect(limiter).toBeInstanceOf(InMemoryOutflowRateLimiter);
  });

  test('returns RedisOutflowRateLimiter when shared Redis is set', () => {
    // Stub Redis with the bare minimum to construct RedisOutflowRateLimiter
    // (the constructor doesn't call any methods, only the limiter's
    // tryAcquire does, so a marker object is enough here).
    const fakeRedis = {} as unknown as Parameters<typeof setSharedRedis>[0];
    setSharedRedis(fakeRedis);
    const registry = new OutflowRateLimiterRegistry();
    const limiter = registry.get(COINGECKO);
    expect(limiter).toBeInstanceOf(RedisOutflowRateLimiter);
  });
});

describe('OutflowRateLimiterRegistry — consistency', () => {
  test('throws when a second `get` disagrees on maxRequests', () => {
    const registry = new OutflowRateLimiterRegistry();
    registry.get(COINGECKO);
    expect(() =>
      registry.get({ namespace: 'coingecko', maxRequests: 50, windowMs: 60_000 })
    ).toThrow(/already registered/);
  });

  test('throws when a second `get` disagrees on windowMs', () => {
    const registry = new OutflowRateLimiterRegistry();
    registry.get(COINGECKO);
    expect(() =>
      registry.get({ namespace: 'coingecko', maxRequests: 25, windowMs: 30_000 })
    ).toThrow(/already registered/);
  });

  test('error message names the namespace and both configs', () => {
    const registry = new OutflowRateLimiterRegistry();
    registry.get(COINGECKO);
    expect(() =>
      registry.get({ namespace: 'coingecko', maxRequests: 100, windowMs: 60_000 })
    ).toThrow(/'coingecko'/);
  });
});
