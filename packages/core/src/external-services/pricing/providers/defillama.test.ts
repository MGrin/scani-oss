process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { Token } from '../../../database/schema';
import type { ProviderPriceResult, TokenWithProvider } from '../types';
import type { RateLimiter } from '../utils';
import { DeFiLlamaProvider, isLikelySpamToken } from './defillama';

/**
 * DeFiLlama provider unit tests.
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
    providerMetadata: '{}',
    isScamProbability: 0,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeTokenWithProvider(
  id: string,
  symbol: string,
  providerTokenId: string
): TokenWithProvider {
  return {
    token: makeToken(id, symbol),
    provider: 'defiLlama',
    providerTokenId,
  };
}

function noopRateLimiter(): RateLimiter {
  return {
    execute: (fn: () => Promise<Response>) => fn(),
  } as unknown as RateLimiter;
}

function makeDeFiLlamaProvider() {
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

  const convertPrice = async (_p: string, _f: string, _t: string, _ts: Date) => '0';

  return {
    provider: new DeFiLlamaProvider({
      rateLimiter: noopRateLimiter(),
      convertPrice,
      createFailureResult,
    }),
    failures,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const baseCurrency = makeToken('usd-id', 'USD');
const timestamp = new Date('2025-01-15T12:00:00Z');

describe('DeFiLlamaProvider', () => {
  describe('fetchPrices with valid response', () => {
    it('should parse price correctly from DeFiLlama format', async () => {
      const contractAddress = '0x6b175474e89094c44da98b954eedeac495271d0f';
      const chainName = 'ethereum';
      const key = `${chainName}:${contractAddress}`;

      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              coins: {
                [key]: {
                  decimals: 18,
                  symbol: 'DAI',
                  price: 1.0001,
                  timestamp: 1705320000,
                  confidence: 0.99,
                },
              },
            }),
            { status: 200 }
          )
        )
      );

      // providerTokenId format: "chainId:address" — chainId 1 maps to "ethereum"
      const tokens: TokenWithProvider[] = [
        makeTokenWithProvider('dai-id', 'DAI', `1:${contractAddress}`),
      ];

      const { provider } = makeDeFiLlamaProvider();
      const results = await provider.fetchPrices(tokens, { baseCurrency, timestamp });

      expect(results).toHaveLength(1);
      expect(results[0].tokenId).toBe('dai-id');
      expect(results[0].price).toBe('1.0001');
      expect(results[0].source).toBe('DeFiLlama');
    });

    it('should return empty array for empty token list', async () => {
      const { provider } = makeDeFiLlamaProvider();
      const results = await provider.fetchPrices([], { baseCurrency, timestamp });
      expect(results).toHaveLength(0);
    });

    it('should handle multiple tokens (each as separate request)', async () => {
      let callCount = 0;
      globalThis.fetch = mock((url: string) => {
        callCount++;
        const contractAddress = url.includes('0xaaa') ? '0xaaa' : '0xbbb';
        const chainName = 'ethereum';
        const key = `${chainName}:${contractAddress}`;

        return Promise.resolve(
          new Response(
            JSON.stringify({
              coins: {
                [key]: {
                  decimals: 18,
                  symbol: contractAddress === '0xaaa' ? 'TK1' : 'TK2',
                  price: contractAddress === '0xaaa' ? 1.5 : 2.5,
                  timestamp: 1705320000,
                  confidence: 0.95,
                },
              },
            }),
            { status: 200 }
          )
        );
      });

      const tokens: TokenWithProvider[] = [
        makeTokenWithProvider('tk1-id', 'TK1', '1:0xaaa'),
        makeTokenWithProvider('tk2-id', 'TK2', '1:0xbbb'),
      ];

      const { provider } = makeDeFiLlamaProvider();
      const results = await provider.fetchPrices(tokens, { baseCurrency, timestamp });

      expect(results).toHaveLength(2);
      expect(callCount).toBe(2); // DeFiLlama uses individual requests per token
    });
  });

  describe('handles network error', () => {
    it('should return failure result on network error', async () => {
      globalThis.fetch = mock(() => Promise.reject(new Error('Network error: ECONNREFUSED')));

      const tokens: TokenWithProvider[] = [makeTokenWithProvider('tok-id', 'TOK', '1:0xabc')];

      const { provider, failures } = makeDeFiLlamaProvider();
      const results = await provider.fetchPrices(tokens, { baseCurrency, timestamp });

      expect(results).toHaveLength(1);
      expect(results[0].source).toContain('error');
      expect(results[0].price).toBe('0');
    });

    it('should return failure result on non-200 response', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response('Server Error', { status: 500, statusText: 'Internal Server Error' })
        )
      );

      const tokens: TokenWithProvider[] = [makeTokenWithProvider('tok-id', 'TOK', '1:0xabc')];

      const { provider } = makeDeFiLlamaProvider();
      const results = await provider.fetchPrices(tokens, { baseCurrency, timestamp });

      expect(results).toHaveLength(1);
      expect(results[0].source).toContain('error');
    });

    it('should handle invalid providerTokenId format', async () => {
      const tokens: TokenWithProvider[] = [
        makeTokenWithProvider('tok-id', 'TOK', 'invalid-format'),
      ];

      const { provider } = makeDeFiLlamaProvider();
      const results = await provider.fetchPrices(tokens, { baseCurrency, timestamp });

      expect(results).toHaveLength(1);
      expect(results[0].source).toContain('error');
    });

    it('should handle unsupported chain ID', async () => {
      const tokens: TokenWithProvider[] = [makeTokenWithProvider('tok-id', 'TOK', '99999:0xabc')];

      const { provider } = makeDeFiLlamaProvider();
      const results = await provider.fetchPrices(tokens, { baseCurrency, timestamp });

      expect(results).toHaveLength(1);
      expect(results[0].source).toContain('error');
    });
  });

  describe('confidence scoring', () => {
    it('should reject prices with low confidence (below 0.8)', async () => {
      const contractAddress = '0xdef';
      const key = `ethereum:${contractAddress}`;

      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              coins: {
                [key]: {
                  decimals: 18,
                  symbol: 'LOW',
                  price: 5.0,
                  timestamp: 1705320000,
                  confidence: 0.3, // Below DEFILLAMA_MIN_CONFIDENCE (0.8)
                },
              },
            }),
            { status: 200 }
          )
        )
      );

      const tokens: TokenWithProvider[] = [
        makeTokenWithProvider('low-id', 'LOW', `1:${contractAddress}`),
      ];

      const { provider } = makeDeFiLlamaProvider();
      const results = await provider.fetchPrices(tokens, { baseCurrency, timestamp });

      expect(results).toHaveLength(1);
      expect(results[0].source).toContain('error');
    });

    it('should accept prices with confidence at threshold (0.8)', async () => {
      const contractAddress = '0xgood';
      const key = `ethereum:${contractAddress}`;

      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              coins: {
                [key]: {
                  decimals: 18,
                  symbol: 'OK',
                  price: 10.0,
                  timestamp: 1705320000,
                  confidence: 0.8, // Exactly at threshold
                },
              },
            }),
            { status: 200 }
          )
        )
      );

      const tokens: TokenWithProvider[] = [
        makeTokenWithProvider('ok-id', 'OK', `1:${contractAddress}`),
      ];

      const { provider } = makeDeFiLlamaProvider();
      const results = await provider.fetchPrices(tokens, { baseCurrency, timestamp });

      expect(results).toHaveLength(1);
      expect(results[0].price).toBe('10');
      expect(results[0].source).toBe('DeFiLlama');
    });

    it('should accept prices with high confidence', async () => {
      const contractAddress = '0xhigh';
      const key = `ethereum:${contractAddress}`;

      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              coins: {
                [key]: {
                  decimals: 18,
                  symbol: 'HIGH',
                  price: 100.0,
                  timestamp: 1705320000,
                  confidence: 0.99,
                },
              },
            }),
            { status: 200 }
          )
        )
      );

      const tokens: TokenWithProvider[] = [
        makeTokenWithProvider('high-id', 'HIGH', `1:${contractAddress}`),
      ];

      const { provider } = makeDeFiLlamaProvider();
      const results = await provider.fetchPrices(tokens, { baseCurrency, timestamp });

      expect(results).toHaveLength(1);
      expect(results[0].price).toBe('100');
      expect(results[0].source).toBe('DeFiLlama');
    });

    it('should reject zero price', async () => {
      const contractAddress = '0xzero';
      const key = `ethereum:${contractAddress}`;

      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              coins: {
                [key]: {
                  decimals: 18,
                  symbol: 'ZERO',
                  price: 0,
                  timestamp: 1705320000,
                  confidence: 0.99,
                },
              },
            }),
            { status: 200 }
          )
        )
      );

      const tokens: TokenWithProvider[] = [
        makeTokenWithProvider('zero-id', 'ZERO', `1:${contractAddress}`),
      ];

      const { provider } = makeDeFiLlamaProvider();
      const results = await provider.fetchPrices(tokens, { baseCurrency, timestamp });

      expect(results).toHaveLength(1);
      expect(results[0].source).toContain('error');
    });

    it('should handle token not found in response', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              coins: {},
            }),
            { status: 200 }
          )
        )
      );

      const tokens: TokenWithProvider[] = [
        makeTokenWithProvider('missing-id', 'MISS', '1:0xmissing'),
      ];

      const { provider } = makeDeFiLlamaProvider();
      const results = await provider.fetchPrices(tokens, { baseCurrency, timestamp });

      expect(results).toHaveLength(1);
      expect(results[0].source).toContain('error');
    });
  });
});

// ---------------------------------------------------------------------------
// isLikelySpamToken utility tests
// ---------------------------------------------------------------------------

describe('isLikelySpamToken', () => {
  it('should detect tokens with URLs in name', () => {
    expect(isLikelySpamToken({ name: 'Visit https://scam.com', symbol: 'SAFE' })).toBe(true);
    expect(isLikelySpamToken({ name: 'www.claimfree.xyz', symbol: 'FREE' })).toBe(true);
  });

  it('should detect tokens with scam keywords', () => {
    expect(isLikelySpamToken({ name: 'Claim your reward', symbol: 'RWD' })).toBe(true);
    expect(isLikelySpamToken({ name: 'Free Airdrop Token', symbol: 'AIR' })).toBe(true);
  });

  it('should detect tokens with domain extensions', () => {
    expect(isLikelySpamToken({ name: 'token.xyz', symbol: 'TKN' })).toBe(true);
    expect(isLikelySpamToken({ name: 'swap.io', symbol: 'SWP' })).toBe(true);
  });

  it('should not flag legitimate tokens', () => {
    expect(isLikelySpamToken({ name: 'Bitcoin', symbol: 'BTC' })).toBe(false);
    expect(isLikelySpamToken({ name: 'Ethereum', symbol: 'ETH' })).toBe(false);
    expect(isLikelySpamToken({ name: 'USD Coin', symbol: 'USDC' })).toBe(false);
  });

  it('should detect Telegram references', () => {
    expect(isLikelySpamToken({ name: 'Join t.me/scam', symbol: 'TG' })).toBe(true);
  });

  it('should detect $ prefix in symbol', () => {
    expect(isLikelySpamToken({ name: 'Legit', symbol: '$SCAM' })).toBe(true);
  });
});
