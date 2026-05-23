import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { makeMockToken } from '../../src/core/testing';
import { FrankfurterProvider } from '../../src/providers/frankfurter';

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

const eurToken = makeMockToken({ id: 'eur', symbol: 'EUR', name: 'EUR' });

describe('FrankfurterProvider', () => {
  test('canPrice gates on supported fiat allowlist', () => {
    const p = new FrankfurterProvider(passthroughLimiter());
    expect(p.canPrice(makeMockToken({ symbol: 'USD' }))).toBe(true);
    expect(p.canPrice(makeMockToken({ symbol: 'GBP' }))).toBe(true);
    expect(p.canPrice(makeMockToken({ symbol: 'BTC' }))).toBe(false);
    expect(p.canPrice(makeMockToken({ symbol: 'NOPE' }))).toBe(false);
  });

  test('fetchCurrentPrice returns identity quote when from === to', async () => {
    const p = new FrankfurterProvider(passthroughLimiter());
    const eur = makeMockToken({ id: 'eur', symbol: 'EUR' });
    const quote = await p.fetchCurrentPrice(eur, { baseCurrency: eurToken });
    expect(quote?.price).toBe('1');
    expect(quote?.source).toBe('frankfurter_identity');
  });

  test('fetchCurrentPrice returns ECB rate from /latest', async () => {
    const p = new FrankfurterProvider(passthroughLimiter());
    const usd = makeMockToken({ id: 'usd', symbol: 'USD' });
    const originalFetch = globalThis.fetch;
    let capturedUrl = '';
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ rates: { EUR: 0.92 }, date: '2024-03-05' }), {
        status: 200,
      });
    }) as typeof fetch;
    try {
      const quote = await p.fetchCurrentPrice(usd, { baseCurrency: eurToken });
      expect(quote?.price).toBe('0.92');
      expect(quote?.source).toBe('frankfurter');
      expect(capturedUrl).toContain('/latest?from=USD&to=EUR');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchCurrentPrice returns null when both currencies fall outside the allowlist', async () => {
    const p = new FrankfurterProvider(passthroughLimiter());
    const result = await p.fetchCurrentPrice(makeMockToken({ symbol: 'NOPE' }), {
      baseCurrency: eurToken,
    });
    expect(result).toBeNull();
  });

  test('fetchCurrentPrice falls back to exchangerate-api for RUB (not in Frankfurter set)', async () => {
    const p = new FrankfurterProvider(passthroughLimiter());
    const rub = makeMockToken({ id: 'rub', symbol: 'RUB' });
    const usdToken = makeMockToken({ id: 'usd', symbol: 'USD', name: 'USD' });
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      if (url.includes('exchangerate-api.com')) {
        return new Response(JSON.stringify({ rates: { USD: 0.0107 } }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    try {
      const quote = await p.fetchCurrentPrice(rub, { baseCurrency: usdToken });
      expect(quote?.price).toBe('0.0107');
      expect(quote?.source).toBe('exchangerate-api');
      expect(calls.some((u) => u.includes('exchangerate-api.com/v4/latest/RUB'))).toBe(true);
      expect(calls.some((u) => u.includes('frankfurter.app'))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchHistoricalPrice returns identity quote when from === to', async () => {
    const p = new FrankfurterProvider(passthroughLimiter());
    const eur = makeMockToken({ id: 'eur', symbol: 'EUR' });
    const at = new Date('2024-03-05T00:00:00Z');
    const quote = await p.fetchHistoricalPrice(eur, at, { baseCurrency: eurToken });
    expect(quote?.price).toBe('1');
    expect(quote?.source).toBe('frankfurter_identity');
  });

  test('fetchHistoricalPrice returns ECB rate from upstream', async () => {
    const p = new FrankfurterProvider(passthroughLimiter());
    const usd = makeMockToken({ id: 'usd', symbol: 'USD' });
    const originalFetch = globalThis.fetch;
    let capturedUrl = '';
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ rates: { EUR: 0.92 }, date: '2024-03-05' }), {
        status: 200,
      });
    }) as typeof fetch;
    try {
      const at = new Date('2024-03-05T00:00:00Z');
      const quote = await p.fetchHistoricalPrice(usd, at, { baseCurrency: eurToken });
      expect(quote?.price).toBe('0.92');
      expect(capturedUrl).toContain('2024-03-05?from=USD&to=EUR');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchHistoricalPrice returns null when target currency unsupported', async () => {
    const p = new FrankfurterProvider(passthroughLimiter());
    const usd = makeMockToken({ id: 'usd', symbol: 'USD' });
    const noSuch = makeMockToken({ id: 'x', symbol: 'NOPE' });
    const result = await p.fetchHistoricalPrice(usd, new Date(), { baseCurrency: noSuch });
    expect(result).toBeNull();
  });
});
