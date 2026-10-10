import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as sentry from '@scani/logging/sentry';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { lastRefusal } from '../../src/core/refusals';
import { makeMockToken } from '../../src/core/testing';
import { CoinGeckoProvider } from '../../src/providers/coingecko';

const limiter = { execute: async <T>(fn: () => Promise<T>) => fn() } as OutflowRateLimiter;
const usd = makeMockToken({ id: 'usd', symbol: 'USD', name: 'USD' });
const btc = makeMockToken({ id: 'btc', symbol: 'BTC' });
const originalFetch = globalThis.fetch;

function answer(...statuses: number[]) {
  let i = 0;
  globalThis.fetch = (async () => {
    const status = statuses[Math.min(i++, statuses.length - 1)] ?? 200;
    return new Response(status === 200 ? JSON.stringify({ bitcoin: { usd: 1 } }) : 'slow down', {
      status,
    });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('CoinGecko 429s are counted (SC-1602)', () => {
  test('every 429 attempt is reported, by tier and endpoint, retried ones included', async () => {
    const capture = spyOn(sentry, 'captureWarning').mockImplementation(() => {});
    answer(429, 429, 429);
    try {
      const quote = await new CoinGeckoProvider(limiter).fetchCurrentPrice(btc, {
        baseCurrency: usd,
      });
      expect(quote).toBeNull();
      expect(capture).toHaveBeenCalledTimes(3);
      expect(capture).toHaveBeenCalledWith(
        'CoinGecko 429',
        { provider: 'coingecko', endpoint: 'simple_price', tier: 'public' },
        ['coingecko-429', 'public']
      );
      expect(lastRefusal('coingecko')).toBeGreaterThan(Date.now() - 60_000);
    } finally {
      capture.mockRestore();
    }
  }, 30_000);

  test('an answered request reports nothing', async () => {
    const capture = spyOn(sentry, 'captureWarning').mockImplementation(() => {});
    answer(200);
    try {
      await new CoinGeckoProvider(limiter, { apiKey: 'k' }).fetchCurrentPrice(btc, {
        baseCurrency: usd,
      });
      expect(capture).not.toHaveBeenCalled();
    } finally {
      capture.mockRestore();
    }
  });
  test('a 429 a retry cleared is counted once, returns the price, and records no refusal', async () => {
    const capture = spyOn(sentry, 'captureWarning').mockImplementation(() => {});
    const before = lastRefusal('coingecko');
    answer(429, 200);
    try {
      const quote = await new CoinGeckoProvider(limiter).fetchCurrentPrice(btc, {
        baseCurrency: usd,
      });
      expect(quote?.price).toBe('1');
      expect(capture).toHaveBeenCalledTimes(1);
      expect(lastRefusal('coingecko')).toBe(before);
    } finally {
      capture.mockRestore();
    }
  }, 30_000);
});
