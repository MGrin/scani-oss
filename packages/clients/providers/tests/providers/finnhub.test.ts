import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { makeMockToken } from '../../src/core/testing';
import { FinnhubProvider } from '../../src/providers/finnhub';

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

const usdToken = makeMockToken({ id: 'usd', symbol: 'USD', name: 'USD' });

describe('FinnhubProvider', () => {
  test('canPrice requires explicit finnhub.symbol metadata', () => {
    const p = new FinnhubProvider(passthroughLimiter(), { apiKey: 'k' });
    // Positive: token enriched by the search / token-identity flow.
    expect(
      p.canPrice(
        makeMockToken({ symbol: 'AAPL', providerMetadata: { finnhub: { symbol: 'AAPL' } } })
      )
    ).toBe(true);
    // Negative: bare metadata is no longer enough — the old `!etherscan`
    // heuristic let RUB/GBP through and burned 5s/candidate on 403 retries.
    expect(p.canPrice(makeMockToken({ symbol: 'AAPL', providerMetadata: {} }))).toBe(false);
    expect(p.canPrice(makeMockToken({ symbol: 'RUB', providerMetadata: {} }))).toBe(false);
    // Negative: EVM-tagged crypto.
    expect(
      p.canPrice(
        makeMockToken({
          symbol: 'USDC',
          providerMetadata: { etherscan: { chainId: 1, contractAddress: '0xabc' } },
        })
      )
    ).toBe(false);
  });

  test('canPrice rejects non-US exchange suffixes even when finnhub.symbol is set', () => {
    const p = new FinnhubProvider(passthroughLimiter(), { apiKey: 'k' });
    expect(
      p.canPrice(
        makeMockToken({
          symbol: 'XEQT.TO',
          providerMetadata: { finnhub: { symbol: 'XEQT.TO' } },
        })
      )
    ).toBe(false);
    expect(
      p.canPrice(
        makeMockToken({
          symbol: 'XEQT.NE',
          providerMetadata: { finnhub: { symbol: 'XEQT.NE' } },
        })
      )
    ).toBe(false);
  });

  test('fetchCurrentPrice returns USD price from /quote', async () => {
    const p = new FinnhubProvider(passthroughLimiter(), { apiKey: 'test-key' });
    const aapl = makeMockToken({ id: 'aapl', symbol: 'AAPL' });
    const originalFetch = globalThis.fetch;
    let capturedUrl = '';
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ c: 175.5, d: 0, dp: 0, h: 0, l: 0, o: 0, pc: 0, t: 0 }),
        { status: 200 }
      );
    }) as typeof fetch;
    try {
      const quote = await p.fetchCurrentPrice(aapl, { baseCurrency: usdToken });
      expect(quote?.price).toBe('175.5');
      expect(quote?.source).toBe('finnhub');
      expect(capturedUrl).toContain('symbol=AAPL');
      expect(capturedUrl).toContain('token=test-key');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchCurrentPrice returns null on c=0', async () => {
    const p = new FinnhubProvider(passthroughLimiter(), { apiKey: 'test-key' });
    const aapl = makeMockToken({ id: 'aapl', symbol: 'AAPL' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ c: 0, d: 0, dp: 0, h: 0, l: 0, o: 0, pc: 0, t: 0 }), {
        status: 200,
      })) as typeof fetch;
    try {
      const quote = await p.fetchCurrentPrice(aapl, { baseCurrency: usdToken });
      expect(quote).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('enrichTokenIdentity normalizes symbol into finnhub.symbol', async () => {
    const p = new FinnhubProvider(passthroughLimiter(), { apiKey: 'k' });
    const result = await p.enrichTokenIdentity({ symbol: 'AAPL' });
    expect(result?.finnhub?.symbol).toBe('AAPL');
  });

  test('fetchHistoricalPrice picks closest bar from /stock/candle response', async () => {
    const p = new FinnhubProvider(passthroughLimiter(), { apiKey: 'test-key' });
    const aapl = makeMockToken({ id: 'aapl', symbol: 'AAPL' });
    // Five trading days centered roughly on 2024-03-05.
    const t0 = Math.floor(new Date('2024-03-04T13:30:00Z').getTime() / 1000);
    const day = 24 * 60 * 60;
    const candles = {
      s: 'ok' as const,
      c: [180.1, 181.2, 182.3, 183.4, 184.5],
      h: [0, 0, 0, 0, 0],
      l: [0, 0, 0, 0, 0],
      o: [0, 0, 0, 0, 0],
      v: [0, 0, 0, 0, 0],
      t: [t0, t0 + day, t0 + 2 * day, t0 + 3 * day, t0 + 4 * day],
    };
    const originalFetch = globalThis.fetch;
    let capturedUrl = '';
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify(candles), { status: 200 });
    }) as typeof fetch;
    try {
      // Target halfway between bar[2] (t0 + 2d) and bar[3] (t0 + 3d),
      // ever so slightly closer to bar[2] — closest-bar should pick it.
      const at = new Date((t0 + 2 * day + day / 2 - 60) * 1000);
      const quote = await p.fetchHistoricalPrice(aapl, at, { baseCurrency: usdToken });
      expect(quote?.price).toBe('182.3');
      expect(quote?.source).toBe('finnhub_historical');
      expect(capturedUrl).toContain('/stock/candle');
      expect(capturedUrl).toContain('resolution=D');
      expect(capturedUrl).toContain('symbol=AAPL');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchHistoricalPrice returns null on no_data response', async () => {
    const p = new FinnhubProvider(passthroughLimiter(), { apiKey: 'test-key' });
    const aapl = makeMockToken({ id: 'aapl', symbol: 'AAPL' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ s: 'no_data' }), { status: 200 })) as typeof fetch;
    try {
      const at = new Date('2024-03-05T12:00:00Z');
      const quote = await p.fetchHistoricalPrice(aapl, at, { baseCurrency: usdToken });
      expect(quote).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('searchTokens ranks exact symbol match ahead of regional variants', async () => {
    const p = new FinnhubProvider(passthroughLimiter(), { apiKey: 'test-key' });
    const originalFetch = globalThis.fetch;
    // Finnhub returns regional listings before the bare ticker — without
    // pre-sorting, slicing to limit=2 would drop TSLA itself.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          count: 4,
          result: [
            {
              symbol: 'TSLA.TO',
              displaySymbol: 'TSLA.TO',
              description: 'Tesla CDR',
              type: 'Canadian DR',
            },
            {
              symbol: 'TSLA.MX',
              displaySymbol: 'TSLA.MX',
              description: 'Tesla MX',
              type: 'Common Stock',
            },
            {
              symbol: 'TSLA.NE',
              displaySymbol: 'TSLA.NE',
              description: 'Tesla NEO',
              type: 'Common Stock',
            },
            {
              symbol: 'TSLA',
              displaySymbol: 'TSLA',
              description: 'Tesla Inc',
              type: 'Common Stock',
            },
          ],
        }),
        { status: 200 }
      )) as typeof fetch;
    try {
      const results = await p.searchTokens('TSLA', 2);
      expect(results).toHaveLength(2);
      expect(results[0]?.symbol).toBe('TSLA');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchHistoricalRange chunks multi-year requests into 1-year windows', async () => {
    const p = new FinnhubProvider(passthroughLimiter(), { apiKey: 'test-key' });
    const aapl = makeMockToken({ id: 'aapl', symbol: 'AAPL' });

    const from = new Date('2022-01-01T00:00:00Z');
    const to = new Date('2024-06-01T00:00:00Z');

    const calls: Array<{ from: number; to: number }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      const u = new URL(url);
      const f = Number(u.searchParams.get('from'));
      const t = Number(u.searchParams.get('to'));
      calls.push({ from: f, to: t });
      // Return one bar per window so we can count windows from the
      // resulting quotes too.
      const barTime = f + 1000;
      const close = 100 + calls.length;
      return new Response(
        JSON.stringify({
          s: 'ok',
          c: [close],
          h: [0],
          l: [0],
          o: [0],
          v: [0],
          t: [barTime],
        }),
        { status: 200 }
      );
    }) as typeof fetch;
    try {
      const quotes = await p.fetchHistoricalRange(aapl, from, to, { baseCurrency: usdToken });
      // 2022-01-01 → 2024-06-01 spans ~2.4 years; 1-year windows ⇒ 3 calls.
      expect(calls.length).toBe(3);
      expect(quotes.length).toBe(3);
      // Windows must be contiguous (no overlap, no gap > 1 second).
      for (let i = 1; i < calls.length; i++) {
        const prev = calls[i - 1];
        const cur = calls[i];
        if (!prev || !cur) throw new Error('unreachable');
        expect(cur.from).toBe(prev.to + 1);
      }
      const last = calls[calls.length - 1];
      if (!last) throw new Error('unreachable');
      expect(last.to).toBe(Math.floor(to.getTime() / 1000));
      expect(quotes[0]?.source).toBe('finnhub_historical');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
