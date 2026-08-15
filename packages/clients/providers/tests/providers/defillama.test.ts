import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { makeMockToken } from '../../src/core/testing';
import { DeFiLlamaProvider } from '../../src/providers/defillama';

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

const usdToken = makeMockToken({ id: 'usd', symbol: 'USD', name: 'USD' });

describe('DeFiLlamaProvider', () => {
  test('canPrice gates on a derivable coin key (etherscan or coingecko metadata)', () => {
    const p = new DeFiLlamaProvider(passthroughLimiter());
    const eth = makeMockToken({
      id: 't',
      symbol: 'ETH',
      providerMetadata: {
        etherscan: { chainId: 1, contractAddress: '0xabc' },
      },
    });
    const cg = makeMockToken({
      id: 't2',
      symbol: 'BTC',
      providerMetadata: { coingecko: { id: 'bitcoin', symbol: 'BTC' } },
    });
    const unknown = makeMockToken({ id: 't3', symbol: 'WAT', providerMetadata: {} });
    expect(p.canPrice(eth)).toBe(true);
    expect(p.canPrice(cg)).toBe(true);
    expect(p.canPrice(unknown)).toBe(false);
  });

  test('fetchCurrentPrice returns a quote when confidence threshold is met', async () => {
    const p = new DeFiLlamaProvider(passthroughLimiter());
    const token = makeMockToken({
      id: 'btc',
      symbol: 'BTC',
      providerMetadata: { coingecko: { id: 'bitcoin', symbol: 'BTC' } },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          coins: { 'coingecko:bitcoin': { price: 50000, confidence: 0.99 } },
        }),
        { status: 200 }
      );
    }) as typeof fetch;
    try {
      const q = await p.fetchCurrentPrice(token, { baseCurrency: usdToken });
      expect(q?.price).toBe('50000');
      expect(q?.source).toBe('defillama');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchCurrentPrice rejects below-threshold confidence', async () => {
    const p = new DeFiLlamaProvider(passthroughLimiter());
    const token = makeMockToken({
      id: 'btc',
      symbol: 'BTC',
      providerMetadata: { coingecko: { id: 'bitcoin', symbol: 'BTC' } },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          coins: { 'coingecko:bitcoin': { price: 1, confidence: 0.1 } },
        }),
        { status: 200 }
      )) as typeof fetch;
    try {
      const q = await p.fetchCurrentPrice(token, { baseCurrency: usdToken });
      expect(q).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  /**
   * SC-171. `/chart` refuses more than 500 points per request. The old
   * code asked for up to 1825 in one call, so every range longer than
   * 500 days came back HTTP 400 — and the `!response.ok` branch returned
   * that as `[]`, which the backfill read as "this token has no price
   * history" and answered with a week-long unpriceable cooldown. Prices
   * older than 500 days could not be fetched for any token, ever.
   */
  describe('fetchHistoricalRange', () => {
    const btc = makeMockToken({
      id: 'btc',
      symbol: 'BTC',
      providerMetadata: { coingecko: { id: 'bitcoin', symbol: 'BTC' } },
    });
    const dayMs = 24 * 60 * 60 * 1000;

    function stubFetch(handler: (url: string, span: number, start: number) => Response): {
      restore: () => void;
      spans: number[];
    } {
      const originalFetch = globalThis.fetch;
      const spans: number[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        const span = Number(new URL(url).searchParams.get('span'));
        const start = Number(new URL(url).searchParams.get('start'));
        spans.push(span);
        return handler(url, span, start);
      }) as typeof fetch;
      return { restore: () => (globalThis.fetch = originalFetch), spans };
    }

    function barsResponse(startSec: number, span: number): Response {
      return new Response(
        JSON.stringify({
          coins: {
            'coingecko:bitcoin': {
              confidence: 0.99,
              prices: Array.from({ length: span }, (_, i) => ({
                timestamp: startSec + i * 86_400,
                price: 100 + i,
              })),
            },
          },
        }),
        { status: 200 }
      );
    }

    test('never asks for more than 500 points in one request', async () => {
      const p = new DeFiLlamaProvider(passthroughLimiter());
      const from = new Date('2021-09-06T00:00:00Z');
      const to = new Date(from.getTime() + 1325 * dayMs);
      const stub = stubFetch((_url, span, start) => barsResponse(start, span));
      try {
        const quotes = await p.fetchHistoricalRange(btc, from, to, { baseCurrency: usdToken });
        expect(stub.spans.length).toBe(3);
        expect(Math.max(...stub.spans)).toBeLessThanOrEqual(500);
        expect(stub.spans.reduce((a, b) => a + b, 0)).toBe(1326);
        expect(quotes.length).toBe(1326);
      } finally {
        stub.restore();
      }
    });

    test('walks the windows forward rather than re-requesting the first', async () => {
      const p = new DeFiLlamaProvider(passthroughLimiter());
      const from = new Date('2021-09-06T00:00:00Z');
      const to = new Date(from.getTime() + 1200 * dayMs);
      const starts: number[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const params = new URL(String(input)).searchParams;
        const start = Number(params.get('start'));
        starts.push(start);
        return barsResponse(start, Number(params.get('span')));
      }) as typeof fetch;
      try {
        await p.fetchHistoricalRange(btc, from, to, { baseCurrency: usdToken });
        expect(starts).toEqual([
          Math.floor(from.getTime() / 1000),
          Math.floor(from.getTime() / 1000) + 500 * 86_400,
          Math.floor(from.getTime() / 1000) + 1000 * 86_400,
        ]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    /** The assertion the whole bug reduces to. */
    test('throws on a rejected request instead of reporting it as no data', async () => {
      const p = new DeFiLlamaProvider(passthroughLimiter());
      const stub = stubFetch(
        () =>
          new Response(
            JSON.stringify({ message: 'Requested 1325 data points exceeds the maximum of 500.' }),
            { status: 400 }
          )
      );
      try {
        await expect(
          p.fetchHistoricalRange(btc, new Date('2021-09-06T00:00:00Z'), new Date(), {
            baseCurrency: usdToken,
          })
        ).rejects.toThrow(/400/);
      } finally {
        stub.restore();
      }
    });

    test('a clean 200 with no bars is an answer, and returns empty rather than throwing', async () => {
      const p = new DeFiLlamaProvider(passthroughLimiter());
      const stub = stubFetch(() => new Response(JSON.stringify({ coins: {} }), { status: 200 }));
      try {
        const quotes = await p.fetchHistoricalRange(
          btc,
          new Date('2021-09-06T00:00:00Z'),
          new Date(),
          {
            baseCurrency: usdToken,
          }
        );
        expect(quotes).toEqual([]);
      } finally {
        stub.restore();
      }
    });

    test('keeps the bars it did get when a later window fails', async () => {
      const p = new DeFiLlamaProvider(passthroughLimiter());
      const from = new Date('2021-09-06T00:00:00Z');
      const to = new Date(from.getTime() + 1200 * dayMs);
      let call = 0;
      const stub = stubFetch((_url, span, start) => {
        call++;
        // 400, not 5xx: `fetchWithTimeout` retries 5xx with exponential
        // backoff, and this test is about the failure reaching us, not
        // about the retry policy.
        return call === 1 ? barsResponse(start, span) : new Response('rejected', { status: 400 });
      });
      try {
        const quotes = await p.fetchHistoricalRange(btc, from, to, { baseCurrency: usdToken });
        expect(quotes.length).toBe(500);
      } finally {
        stub.restore();
      }
    });
  });

  test('enrichTokenIdentity prefers EVM chain:contract', async () => {
    const p = new DeFiLlamaProvider(passthroughLimiter());
    const result = await p.enrichTokenIdentity({
      symbol: 'USDC',
      providerMetadata: {
        etherscan: { chainId: 1, contractAddress: '0xABC' },
      },
    });
    expect(result?.defillama?.coin).toBe('ethereum:0xabc');
  });

  test('enrichTokenIdentity falls back to coingecko id', async () => {
    const p = new DeFiLlamaProvider(passthroughLimiter());
    const result = await p.enrichTokenIdentity({
      symbol: 'BTC',
      providerMetadata: { coingecko: { id: 'bitcoin', symbol: 'BTC' } },
    });
    expect(result?.defillama?.coin).toBe('coingecko:bitcoin');
  });
});
