import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { makeMockToken } from '../../src/core/testing';
import { CoinGeckoProvider } from '../../src/providers/coingecko';

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

const usdToken = makeMockToken({ id: 'usd', symbol: 'USD', name: 'USD' });

describe('CoinGeckoProvider', () => {
  test('canPrice gates on a known coingecko id', () => {
    const p = new CoinGeckoProvider(passthroughLimiter());
    const btc = makeMockToken({ id: 'btc', symbol: 'BTC' });
    const unknown = makeMockToken({ id: 'wat', symbol: 'WAT-FOO' });
    expect(p.canPrice(btc)).toBe(true);
    expect(p.canPrice(unknown)).toBe(false);
  });

  test('fetchCurrentPrice returns a quote in user base when CoinGecko supports it', async () => {
    const p = new CoinGeckoProvider(passthroughLimiter());
    const btc = makeMockToken({ id: 'btc', symbol: 'BTC' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/simple/price')) {
        return new Response(JSON.stringify({ bitcoin: { usd: 50000 } }), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;
    try {
      const quote = await p.fetchCurrentPrice(btc, { baseCurrency: usdToken });
      expect(quote?.price).toBe('50000');
      expect(quote?.source).toBe('coingecko');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchHistoricalPrice formats DD-MM-YYYY and pulls from market_data.current_price', async () => {
    const p = new CoinGeckoProvider(passthroughLimiter());
    const btc = makeMockToken({ id: 'btc', symbol: 'BTC' });
    const originalFetch = globalThis.fetch;
    let capturedUrl = '';
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ market_data: { current_price: { usd: 30000 } } }), {
        status: 200,
      });
    }) as typeof fetch;
    try {
      const at = new Date('2024-03-05T12:00:00Z');
      const quote = await p.fetchHistoricalPrice(btc, at, { baseCurrency: usdToken });
      expect(quote?.price).toBe('30000');
      expect(capturedUrl).toContain('date=05-03-2024');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('enrichTokenIdentity fills coingecko.id from a well-known symbol', async () => {
    const p = new CoinGeckoProvider(passthroughLimiter());
    const result = await p.enrichTokenIdentity({ symbol: 'BTC' });
    expect(result?.coingecko?.id).toBe('bitcoin');
  });
});
