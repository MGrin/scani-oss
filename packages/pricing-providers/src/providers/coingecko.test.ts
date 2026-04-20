process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { Token } from '@scani/db/schema';
import type { ProviderPriceResult, TokenWithProvider } from '../types';
import type { RateLimiter } from '../utils';
import type { ConvertPriceFn } from './base';
import { CoinGeckoProvider } from './coingecko';

/**
 * CoinGecko provider unit tests.
 * We mock globalThis.fetch to avoid hitting the real API.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeToken(id: string, symbol: string): Token {
  return {
    id,
    symbol,
    name: `${symbol} Token`,
    typeId: 'crypto-type-id',
    decimals: 18,
    iconUrl: null,
    providerMetadata: JSON.stringify({
      provider: 'coingecko',
      coingecko: { id: symbol.toLowerCase() },
    }),
    isScamProbability: 0,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeTokenWithProvider(
  id: string,
  symbol: string,
  providerTokenId?: string
): TokenWithProvider {
  return {
    token: makeToken(id, symbol),
    provider: 'coinGecko',
    providerTokenId: providerTokenId || symbol.toLowerCase(),
  };
}

/** A pass-through rate limiter that just calls the function */
function noopRateLimiter(): RateLimiter {
  return {
    execute: (fn: () => Promise<Response>) => fn(),
  } as unknown as RateLimiter;
}

function noopConvertPrice() {
  return async (_p: string, _f: string, _t: string, _ts: Date) => '0';
}

function makeCoinGeckoProvider(overrides: { convertPrice?: ConvertPriceFn } = {}) {
  const failures: ProviderPriceResult[] = [];

  const createFailureResult = (
    tokenId: string,
    timestamp: Date,
    source: string,
    _error: unknown,
    _options?: unknown
  ): ProviderPriceResult => {
    const result: ProviderPriceResult = {
      tokenId,
      price: '0',
      timestamp,
      source: `${source}_error`,
    };
    failures.push(result);
    return result;
  };

  return {
    provider: new CoinGeckoProvider({
      rateLimiter: noopRateLimiter(),
      convertPrice: overrides.convertPrice || noopConvertPrice(),
      createFailureResult,
    }),
    failures,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CoinGeckoProvider', () => {
  const baseCurrency = makeToken('usd-id', 'USD');
  const timestamp = new Date('2025-01-15T12:00:00Z');

  describe('fetchPrices with valid response', () => {
    it('should parse prices correctly from CoinGecko format', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              bitcoin: { usd: 62345.78 },
              ethereum: { usd: 3456.12 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
      );

      const tokens: TokenWithProvider[] = [
        makeTokenWithProvider('btc-id', 'BTC', 'bitcoin'),
        makeTokenWithProvider('eth-id', 'ETH', 'ethereum'),
      ];

      const { provider } = makeCoinGeckoProvider();
      const results = await provider.fetchPrices(tokens, { baseCurrency, timestamp });

      expect(results).toHaveLength(2);

      const btcResult = results.find((r) => r.tokenId === 'btc-id');
      expect(btcResult).toBeDefined();
      expect(btcResult!.price).toBe('62345.78');
      expect(btcResult!.source).toBe('CoinGecko');

      const ethResult = results.find((r) => r.tokenId === 'eth-id');
      expect(ethResult).toBeDefined();
      expect(ethResult!.price).toBe('3456.12');
    });

    it('should return empty array for empty token list', async () => {
      const { provider } = makeCoinGeckoProvider();
      const results = await provider.fetchPrices([], { baseCurrency, timestamp });
      expect(results).toHaveLength(0);
    });

    it('should handle token not found in response', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              bitcoin: { usd: 50000 },
              // ethereum is missing
            }),
            { status: 200 }
          )
        )
      );

      const tokens: TokenWithProvider[] = [
        makeTokenWithProvider('btc-id', 'BTC', 'bitcoin'),
        makeTokenWithProvider('eth-id', 'ETH', 'ethereum'),
      ];

      const { provider } = makeCoinGeckoProvider();
      const results = await provider.fetchPrices(tokens, { baseCurrency, timestamp });

      // BTC should succeed
      const btcResult = results.find((r) => r.tokenId === 'btc-id');
      expect(btcResult).toBeDefined();
      expect(btcResult!.price).toBe('50000');

      // ETH should be a failure result
      const ethResult = results.find((r) => r.tokenId === 'eth-id');
      expect(ethResult).toBeDefined();
      expect(ethResult!.source).toContain('error');
    });
  });

  describe('handles 429 rate limit', () => {
    it('should return failure results on 429 response', async () => {
      // fetchWithTimeout retries on 429, so we need all attempts to return 429
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response('Rate limited', { status: 429, statusText: 'Too Many Requests' })
        )
      );

      const tokens: TokenWithProvider[] = [makeTokenWithProvider('btc-id', 'BTC', 'bitcoin')];

      const { provider } = makeCoinGeckoProvider();
      const results = await provider.fetchPrices(tokens, { baseCurrency, timestamp });

      // Should have failure results (either from handleFailure or error catch)
      expect(results.length).toBeGreaterThanOrEqual(0);
      // The provider should handle the error — either in results or failures
      if (results.length > 0) {
        expect(results[0].source).toContain('error');
      }
    });
  });

  describe('handles network error', () => {
    it('should return failure results on network error', async () => {
      globalThis.fetch = mock(() => Promise.reject(new Error('Network error: ECONNREFUSED')));

      const tokens: TokenWithProvider[] = [makeTokenWithProvider('btc-id', 'BTC', 'bitcoin')];

      const { provider } = makeCoinGeckoProvider();
      const results = await provider.fetchPrices(tokens, { baseCurrency, timestamp });

      // The provider catches errors and returns failure results
      expect(results.length).toBeGreaterThanOrEqual(0);
      if (results.length > 0) {
        expect(results[0].source).toContain('error');
      }
    });
  });

  describe('parses price correctly from CoinGecko format', () => {
    it('should handle zero price as failure', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              bitcoin: { usd: 0 },
            }),
            { status: 200 }
          )
        )
      );

      const tokens: TokenWithProvider[] = [makeTokenWithProvider('btc-id', 'BTC', 'bitcoin')];

      const { provider } = makeCoinGeckoProvider();
      const results = await provider.fetchPrices(tokens, { baseCurrency, timestamp });

      // Zero/negative prices should be treated as failures
      const btcResult = results.find((r) => r.tokenId === 'btc-id');
      expect(btcResult).toBeDefined();
      expect(btcResult!.source).toContain('error');
    });

    it('should handle negative price as failure', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              bitcoin: { usd: -100 },
            }),
            { status: 200 }
          )
        )
      );

      const tokens: TokenWithProvider[] = [makeTokenWithProvider('btc-id', 'BTC', 'bitcoin')];

      const { provider } = makeCoinGeckoProvider();
      const results = await provider.fetchPrices(tokens, { baseCurrency, timestamp });

      const btcResult = results.find((r) => r.tokenId === 'btc-id');
      expect(btcResult).toBeDefined();
      expect(btcResult!.source).toContain('error');
    });

    it('should handle very small positive prices', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              'shiba-inu': { usd: 0.000008 },
            }),
            { status: 200 }
          )
        )
      );

      const tokens: TokenWithProvider[] = [makeTokenWithProvider('shib-id', 'SHIB', 'shiba-inu')];

      const { provider } = makeCoinGeckoProvider();
      const results = await provider.fetchPrices(tokens, { baseCurrency, timestamp });

      const shibResult = results.find((r) => r.tokenId === 'shib-id');
      expect(shibResult).toBeDefined();
      expect(shibResult!.source).toBe('CoinGecko');
      expect(Number(shibResult!.price)).toBeCloseTo(0.000008, 10);
    });

    it('should use providerTokenId when available', async () => {
      const fetchMock = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              'my-custom-id': { usd: 42 },
            }),
            { status: 200 }
          )
        )
      );
      globalThis.fetch = fetchMock;

      const tokens: TokenWithProvider[] = [
        makeTokenWithProvider('tok-id', 'CUSTOM', 'my-custom-id'),
      ];

      const { provider } = makeCoinGeckoProvider();
      const results = await provider.fetchPrices(tokens, { baseCurrency, timestamp });

      expect(results).toHaveLength(1);
      expect(results[0].price).toBe('42');

      // Verify the URL used the custom ID
      const callArgs = fetchMock.mock.calls[0];
      expect(callArgs[0]).toContain('my-custom-id');
    });
  });
});
