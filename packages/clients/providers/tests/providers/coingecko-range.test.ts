import { afterEach, describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { RateLimiterRegistry } from '../../src/core/rate-limiter-registry';
import { makeMockToken } from '../../src/core/testing';
import { CoinGeckoProvider, coingeckoFactory } from '../../src/providers/coingecko';

/**
 * SC-1706. Production runs CoinGecko keyless, and the keyless tier refuses a
 * range reaching back more than 365 days with a 401 (error 10012). The range
 * fetch read that refusal as "no prices", so the nightly backfill recorded
 * every day of it as a miss, the recent year CoinGecko does have included:
 * three held tokens kept 351 missed days each.
 */

const limiter = { execute: async <T>(fn: () => Promise<T>) => fn() } as OutflowRateLimiter;
const usd = makeMockToken({ id: 'usd', symbol: 'USD', name: 'USD' });
const btc = makeMockToken({ id: 'btc', symbol: 'BTC' });
const DAY = 86_400_000;
const originalFetch = globalThis.fetch;

let asked: URL[] = [];
function answer(status: number) {
  asked = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    asked.push(new URL(String(input)));
    const body = status === 200 ? JSON.stringify({ prices: [[Date.now() - DAY, 1]] }) : 'no';
    return new Response(body, { status });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const fromParam = (url: URL | undefined) => Number(url?.searchParams.get('from')) * 1000;

describe('CoinGecko range fetch (SC-1706)', () => {
  test('keyless, it asks only for the last year', async () => {
    answer(200);
    const now = Date.now();
    await new CoinGeckoProvider(limiter).fetchHistoricalRange(
      btc,
      new Date(now - 1800 * DAY),
      new Date(now),
      { baseCurrency: usd }
    );
    expect(asked).toHaveLength(1);
    expect(fromParam(asked[0])).toBeGreaterThan(now - 365 * DAY);
  });

  test('keyed, it asks for the whole range', async () => {
    answer(200);
    const now = Date.now();
    const from = new Date(now - 1800 * DAY);
    await new CoinGeckoProvider(limiter, { apiKey: 'k' }).fetchHistoricalRange(
      btc,
      from,
      new Date(now),
      { baseCurrency: usd }
    );
    expect(fromParam(asked[0])).toBe(Math.floor(from.getTime() / 1000) * 1000);
  });

  test('keyless, a range wholly older than a year is not asked at all', async () => {
    answer(200);
    const now = Date.now();
    const quotes = await new CoinGeckoProvider(limiter).fetchHistoricalRange(
      btc,
      new Date(now - 900 * DAY),
      new Date(now - 400 * DAY),
      { baseCurrency: usd }
    );
    expect(asked).toHaveLength(0);
    expect(quotes).toEqual([]);
  });

  test('a refusal is a failed fetch, not an empty answer', async () => {
    answer(401);
    const now = Date.now();
    const fetching = new CoinGeckoProvider(limiter, { apiKey: 'k' }).fetchHistoricalRange(
      btc,
      new Date(now - 30 * DAY),
      new Date(now),
      { baseCurrency: usd }
    );
    await expect(fetching).rejects.toThrow('401');
  });

  test('a coin CoinGecko does not know is an empty answer', async () => {
    answer(404);
    const now = Date.now();
    const quotes = await new CoinGeckoProvider(limiter, { apiKey: 'k' }).fetchHistoricalRange(
      btc,
      new Date(now - 30 * DAY),
      new Date(now),
      { baseCurrency: usd }
    );
    expect(quotes).toEqual([]);
  });
});

describe('CoinGecko rate limit (SC-1706)', () => {
  async function limitFor(env: Record<string, string | undefined>): Promise<string | undefined> {
    const registry = new RateLimiterRegistry();
    await coingeckoFactory({
      redis: null,
      env,
      rateLimiterRegistry: registry,
      reportCredentialStatus: () => {},
    });
    return registry.list().find((l) => l.namespace === 'coingecko')?.description;
  }

  test('keyless, it stays under the public cap, one call every 6 s and never a burst', async () => {
    expect(await limitFor({})).toBe('CoinGecko: 1 req / 6s');
  });

  test('keyed, it keeps 25 a minute', async () => {
    expect(await limitFor({ COINGECKO_API_KEY: 'k' })).toBe('CoinGecko: 25 req / 60s');
  });
});

describe('CoinGecko retries (SC-1706)', () => {
  // A 429 retried 1 s and then 2 s later cannot outwait a per-minute cap, and
  // those retries took no slot, so a refusal sent more requests, not fewer. On
  // 2026-10-18 one simple_price request was refused at 00:00:42, :43 and :45.
  test('a 429 is retried through the limiter, one slot per attempt', async () => {
    let slots = 0;
    const counting = {
      execute: async <T>(fn: () => Promise<T>) => {
        slots++;
        return fn();
      },
    } as OutflowRateLimiter;
    const statuses = [429, 429, 200];
    asked = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      asked.push(new URL(String(input)));
      const status = statuses.shift() ?? 200;
      const body = status === 200 ? JSON.stringify({ prices: [[Date.now() - DAY, 1]] }) : 'no';
      return new Response(body, { status });
    }) as unknown as typeof fetch;
    const now = Date.now();
    const quotes = await new CoinGeckoProvider(counting, {
      apiKey: 'k',
      penaltyMs: 10,
    }).fetchHistoricalRange(btc, new Date(now - 30 * DAY), new Date(now), { baseCurrency: usd });
    expect(asked).toHaveLength(3);
    expect(slots).toBe(3);
    expect(quotes.length).toBeGreaterThan(0);
  });

  test('a refusal no retry clears still fails after its last attempt', async () => {
    let slots = 0;
    const counting = {
      execute: async <T>(fn: () => Promise<T>) => {
        slots++;
        return fn();
      },
    } as OutflowRateLimiter;
    answer(429);
    const now = Date.now();
    const fetching = new CoinGeckoProvider(counting, {
      apiKey: 'k',
      penaltyMs: 10,
    }).fetchHistoricalRange(btc, new Date(now - 30 * DAY), new Date(now), { baseCurrency: usd });
    await expect(fetching).rejects.toThrow('429');
    expect(asked).toHaveLength(3);
    expect(slots).toBe(3);
  });
});
