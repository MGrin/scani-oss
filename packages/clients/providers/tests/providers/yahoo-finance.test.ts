import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { makeMockToken } from '../../src/core/testing';
import { YahooFinanceProvider } from '../../src/providers/yahoo-finance';
import {
  resolveYahooStockSymbol,
  yahooFxPairSymbol,
} from '../../src/providers/yahoo-finance/symbol';

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

const usdToken = makeMockToken({ id: 'usd', symbol: 'USD', name: 'US Dollar' });

describe('YahooFinanceProvider symbol helpers', () => {
  test('resolveYahooStockSymbol maps .NE → .NEO and infers CAD', () => {
    expect(resolveYahooStockSymbol('XEQT.NE')).toEqual({
      yahooSymbol: 'XEQT.NEO',
      currency: 'CAD',
    });
    expect(resolveYahooStockSymbol('xeqt.ne')).toEqual({
      yahooSymbol: 'XEQT.NEO',
      currency: 'CAD',
    });
  });

  test('resolveYahooStockSymbol preserves .TO and infers CAD', () => {
    expect(resolveYahooStockSymbol('XUU.TO')).toEqual({ yahooSymbol: 'XUU.TO', currency: 'CAD' });
  });

  test('resolveYahooStockSymbol returns USD for bare US tickers', () => {
    expect(resolveYahooStockSymbol('AAPL')).toEqual({ yahooSymbol: 'AAPL', currency: 'USD' });
    expect(resolveYahooStockSymbol('BRK.A')).toEqual({ yahooSymbol: 'BRK.A', currency: 'USD' });
  });

  test('yahooFxPairSymbol formats <FROM><TO>=X', () => {
    expect(yahooFxPairSymbol('rub', 'usd')).toBe('RUBUSD=X');
    expect(yahooFxPairSymbol('CAD', 'USD')).toBe('CADUSD=X');
  });
});

describe('YahooFinanceProvider canPrice', () => {
  const p = new YahooFinanceProvider(passthroughLimiter());

  test('accepts only fiat NOT covered by Frankfurter (RUB / KZT) — duplicates dropped', () => {
    // Frankfurter is the canonical historical-FX source for the major
    // fiats it publishes (AUD/EUR/GBP/JPY/...). Yahoo would otherwise
    // also satisfy canPrice and write duplicate token_prices rows.
    expect(p.canPrice(makeMockToken({ id: '1', symbol: 'RUB' }))).toBe(true);
    expect(p.canPrice(makeMockToken({ id: '2', symbol: 'KZT' }))).toBe(true);
    expect(p.canPrice(makeMockToken({ id: '3', symbol: 'GBP' }))).toBe(false);
    expect(p.canPrice(makeMockToken({ id: '4', symbol: 'EUR' }))).toBe(false);
    expect(p.canPrice(makeMockToken({ id: '5', symbol: 'JPY' }))).toBe(false);
  });

  test('accepts stock-style tickers with and without exchange suffixes', () => {
    expect(p.canPrice(makeMockToken({ id: '1', symbol: 'AAPL' }))).toBe(true);
    expect(p.canPrice(makeMockToken({ id: '2', symbol: 'XEQT.TO' }))).toBe(true);
    expect(p.canPrice(makeMockToken({ id: '3', symbol: 'XEQT.NE' }))).toBe(true);
    expect(p.canPrice(makeMockToken({ id: '4', symbol: 'BRK.A' }))).toBe(true);
  });

  test('rejects garbage symbols', () => {
    expect(p.canPrice(makeMockToken({ id: '1', symbol: '' }))).toBe(false);
    expect(p.canPrice(makeMockToken({ id: '2', symbol: '0xabcdef1234' }))).toBe(false);
  });
});

describe('YahooFinanceProvider fetchHistoricalPrice', () => {
  const at = new Date('2026-03-15T16:00:00Z');

  test('returns a quote for a USD-listed equity', async () => {
    const p = new YahooFinanceProvider(passthroughLimiter());
    const token = makeMockToken({ id: 'aapl', symbol: 'AAPL', name: 'Apple Inc.' });
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      return new Response(
        JSON.stringify({
          chart: {
            result: [
              {
                meta: { currency: 'USD' },
                timestamp: [Math.floor(at.getTime() / 1000)],
                indicators: { quote: [{ close: [184.5] }] },
              },
            ],
            error: null,
          },
        }),
        { status: 200 }
      );
    }) as typeof fetch;
    try {
      const q = await p.fetchHistoricalPrice(token, at, { baseCurrency: usdToken });
      expect(q?.price).toBe('184.5');
      expect(q?.source).toBe('yahoo-finance_historical');
      // Just one upstream call for a USD-quoted listing — no FX cross.
      expect(calls.length).toBe(1);
      expect(calls[0]).toContain('AAPL');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('converts a CAD-listed equity to USD via the FX cross', async () => {
    const p = new YahooFinanceProvider(passthroughLimiter());
    const token = makeMockToken({ id: 'xeqt', symbol: 'XEQT.TO', name: 'iShares XEQT' });
    const ts = Math.floor(at.getTime() / 1000);
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      // First call: stock chart in CAD. Second call: CAD/USD FX cross.
      const isFx = url.includes('CADUSD%3DX') || url.includes('CADUSD=X');
      return new Response(
        JSON.stringify({
          chart: {
            result: [
              {
                meta: { currency: isFx ? 'USD' : 'CAD' },
                timestamp: [ts],
                indicators: { quote: [{ close: [isFx ? 0.74 : 30] }] },
              },
            ],
            error: null,
          },
        }),
        { status: 200 }
      );
    }) as typeof fetch;
    try {
      const q = await p.fetchHistoricalPrice(token, at, { baseCurrency: usdToken });
      // 30 CAD × 0.74 USD/CAD = 22.20 USD
      expect(q?.price).toBe('22.2');
      expect(q?.source).toBe('yahoo-finance_historical');
      expect(calls.length).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('returns a quote for an unsupported-by-frankfurter fiat (RUB)', async () => {
    const p = new YahooFinanceProvider(passthroughLimiter());
    const rub = makeMockToken({ id: 'rub', symbol: 'RUB', name: 'Russian Ruble' });
    const ts = Math.floor(at.getTime() / 1000);
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      return new Response(
        JSON.stringify({
          chart: {
            result: [
              {
                meta: { currency: 'USD' },
                timestamp: [ts],
                indicators: { quote: [{ close: [0.0133] }] },
              },
            ],
            error: null,
          },
        }),
        { status: 200 }
      );
    }) as typeof fetch;
    try {
      const q = await p.fetchHistoricalPrice(rub, at, { baseCurrency: usdToken });
      expect(q?.price).toBe('0.0133');
      expect(q?.source).toBe('yahoo-finance_fx_historical');
      expect(calls.length).toBe(1);
      expect(calls[0]).toMatch(/RUBUSD/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('returns null when Yahoo serves no bars', async () => {
    const p = new YahooFinanceProvider(passthroughLimiter());
    const token = makeMockToken({ id: 'x', symbol: 'AAPL' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ chart: { result: [], error: null } }), {
        status: 200,
      })) as typeof fetch;
    try {
      const q = await p.fetchHistoricalPrice(token, at, { baseCurrency: usdToken });
      expect(q).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('returns null on non-OK Yahoo response', async () => {
    const p = new YahooFinanceProvider(passthroughLimiter());
    const token = makeMockToken({ id: 'x', symbol: 'AAPL' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('Not Found', { status: 404 })) as typeof fetch;
    try {
      const q = await p.fetchHistoricalPrice(token, at, { baseCurrency: usdToken });
      expect(q).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
