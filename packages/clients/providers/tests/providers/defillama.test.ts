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
