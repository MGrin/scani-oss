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
      const quote = await new CoinGeckoProvider(limiter, { penaltyMs: 10 }).fetchCurrentPrice(btc, {
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
      const quote = await new CoinGeckoProvider(limiter, { penaltyMs: 10 }).fetchCurrentPrice(btc, {
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

// SC-1706: every night one 429 became ten or eleven, one every 6 s for a
// minute (2026-10-20..27, all market_chart). CoinGecko's refusal is a penalty
// of about a minute, and each request sent inside it was refused again and
// counted. After a 429 nothing goes out until the penalty has passed.
describe('CoinGecko is left alone after a 429 (SC-1706)', () => {
  const PENALTY_MS = 1_500;

  function recordCalls(...statuses: number[]) {
    const at: number[] = [];
    let i = 0;
    globalThis.fetch = (async () => {
      at.push(Date.now());
      const status = statuses[Math.min(i++, statuses.length - 1)] ?? 200;
      return new Response(status === 200 ? JSON.stringify({ bitcoin: { usd: 1 } }) : 'slow down', {
        status,
      });
    }) as unknown as typeof fetch;
    return at;
  }

  test('the retry after a 429 waits out the penalty', async () => {
    const capture = spyOn(sentry, 'captureWarning').mockImplementation(() => {});
    const at = recordCalls(429, 200);
    try {
      const quote = await new CoinGeckoProvider(limiter, {
        penaltyMs: PENALTY_MS,
      }).fetchCurrentPrice(btc, { baseCurrency: usd });
      expect(quote?.price).toBe('1');
      expect(at).toHaveLength(2);
      expect((at[1] ?? 0) - (at[0] ?? 0)).toBeGreaterThanOrEqual(PENALTY_MS - 20);
    } finally {
      capture.mockRestore();
    }
  }, 10_000);

  test('another price call inside the penalty waits instead of being refused again', async () => {
    const capture = spyOn(sentry, 'captureWarning').mockImplementation(() => {});
    const at = recordCalls(429, 200, 200);
    try {
      const p = new CoinGeckoProvider(limiter, { penaltyMs: PENALTY_MS });
      const first = p.fetchCurrentPrice(btc, { baseCurrency: usd });
      await Bun.sleep(20);
      const second = p.fetchCurrentPrice(btc, { baseCurrency: usd });
      await Promise.all([first, second]);
      expect(capture).toHaveBeenCalledTimes(1);
      for (const t of at.slice(1)) expect(t - (at[0] ?? 0)).toBeGreaterThanOrEqual(PENALTY_MS - 20);
    } finally {
      capture.mockRestore();
    }
  }, 10_000);

  test("a user's search inside the penalty sends nothing and answers empty", async () => {
    const capture = spyOn(sentry, 'captureWarning').mockImplementation(() => {});
    const at = recordCalls(429, 200);
    try {
      const p = new CoinGeckoProvider(limiter, { penaltyMs: PENALTY_MS });
      const price = p.fetchCurrentPrice(btc, { baseCurrency: usd });
      await Bun.sleep(50);
      const results = await p.searchTokens('eth');
      expect(results).toEqual([]);
      expect(at).toHaveLength(1);
      await price;
    } finally {
      capture.mockRestore();
    }
  }, 20_000);

  test("CoinGecko's own Retry-After is the penalty when it sends one", async () => {
    const capture = spyOn(sentry, 'captureWarning').mockImplementation(() => {});
    const at: number[] = [];
    let i = 0;
    globalThis.fetch = (async () => {
      at.push(Date.now());
      if (i++ === 0)
        return new Response('slow down', { status: 429, headers: { 'retry-after': '2' } });
      return new Response(JSON.stringify({ bitcoin: { usd: 1 } }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await new CoinGeckoProvider(limiter, { penaltyMs: 10 }).fetchCurrentPrice(btc, {
        baseCurrency: usd,
      });
      expect((at[1] ?? 0) - (at[0] ?? 0)).toBeGreaterThanOrEqual(1_980);
    } finally {
      capture.mockRestore();
    }
  }, 10_000);
});
