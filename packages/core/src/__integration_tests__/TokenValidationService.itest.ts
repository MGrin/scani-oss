import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

// Note: DATABASE_URL must be set before bun loads modules - use test-preload.ts

// Mock the rate limiters
const mockCoinGeckoRateLimiter = {
  execute: mock(async <T>(fn: () => Promise<T>) => fn()),
};

const mockFinnhubRateLimiter = {
  execute: mock(async <T>(fn: () => Promise<T>) => fn()),
};

const mockPricingService = {
  coinGeckoRateLimiter: mockCoinGeckoRateLimiter,
  finnhubRateLimiter: mockFinnhubRateLimiter,
};

const mockTokenRepository = {};

mock.module('typedi', () => ({
  Container: {
    get: (cls: { name?: string }) => {
      const name = cls?.name || '';
      if (name.includes('PricingService')) return mockPricingService;
      if (name.includes('TokenRepository')) return mockTokenRepository;
      return {};
    },
  },
  Service: () => (target: unknown) => target,
}));

mock.module('../utils/logger', () => ({
  createComponentLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

// Mock the database connection (PricingService imports it at module level)
mock.module('../database/connection', () => ({
  db: {},
  getDb: () => ({}),
}));

// Mock PricingService module to prevent it from loading the real module
mock.module('./PricingService', () => ({
  PricingService: class MockPricingService {
    coinGeckoRateLimiter = mockCoinGeckoRateLimiter;
    finnhubRateLimiter = mockFinnhubRateLimiter;
  },
}));

// Mock the pricing config
mock.module('../config/pricing', () => ({
  config: {
    coinGecko: {
      apiKey: '',
      baseUrl: 'https://api.coingecko.com/api/v3',
    },
    finnhub: {
      apiKey: 'test-finnhub-key',
      baseUrl: 'https://finnhub.io/api/v1',
    },
    exchangeRate: {
      baseUrl: 'https://api.exchangerate-api.com/v4',
    },
    etherscan: {
      apiKey: '',
    },
  },
}));

mock.module('../external-services/pricing/defillama-constants', () => ({
  CHAIN_ID_TO_DEFILLAMA: {
    1: 'ethereum',
    56: 'bsc',
    137: 'polygon',
  } as Record<number, string>,
  DEFILLAMA_MIN_CONFIDENCE: 0.9,
}));

mock.module('../external-services/pricing/provider-config', () => ({
  PROVIDER_CONFIGS: {
    defiLlama: {
      name: 'DeFiLlama',
      baseUrl: 'https://coins.llama.fi',
      rateLimit: 300,
    },
  },
}));

const mockFetchWithTimeout = mock(() => Promise.resolve(new Response()));

mock.module('../external-services/pricing/utils', () => ({
  fetchWithTimeout: mockFetchWithTimeout,
  RateLimiter: class {
    execute = async <T>(fn: () => Promise<T>) => fn();
  },
}));

// Store original fetch and prepare to mock it
const originalFetch = globalThis.fetch;

import { TokenValidationService } from './TokenValidationService';

describe('TokenValidationService', () => {
  let service: TokenValidationService;

  beforeEach(() => {
    mockCoinGeckoRateLimiter.execute.mockReset();
    mockFinnhubRateLimiter.execute.mockReset();
    mockFetchWithTimeout.mockReset();

    // Default: execute passes through to the function
    mockCoinGeckoRateLimiter.execute.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    mockFinnhubRateLimiter.execute.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    mockFetchWithTimeout.mockImplementation(() => Promise.resolve(new Response()));

    service = new TokenValidationService();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('validateTokenByCoinGeckoId', () => {
    it('should return valid result for known coin', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'bitcoin',
              symbol: 'btc',
              name: 'Bitcoin',
              image: { large: 'https://example.com/btc.png' },
              market_data: { current_price: { usd: 50000 } },
            }),
            { status: 200 }
          )
        )
      ) as typeof fetch;

      const result = await service.validateTokenByCoinGeckoId('bitcoin');

      expect(result.isValid).toBe(true);
      expect(result.metadata).toBeDefined();
      expect(result.metadata!.symbol).toBe('BTC');
      expect(result.metadata!.name).toBe('Bitcoin');
      expect(result.metadata!.type).toBe('Crypto');
      expect(result.metadata!.provider).toBe('coingecko');
    });

    it('should return invalid result on API failure', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('Not Found', { status: 404, statusText: 'Not Found' }))
      ) as typeof fetch;

      const result = await service.validateTokenByCoinGeckoId('nonexistent-coin');

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Failed to fetch coin details');
    });

    it('should handle network errors gracefully', async () => {
      globalThis.fetch = mock(() => Promise.reject(new Error('Network error'))) as typeof fetch;

      const result = await service.validateTokenByCoinGeckoId('bitcoin');

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Network error');
    });

    it('should use rate limiter for API calls', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'bitcoin',
              symbol: 'btc',
              name: 'Bitcoin',
            }),
            { status: 200 }
          )
        )
      ) as typeof fetch;

      await service.validateTokenByCoinGeckoId('bitcoin');

      expect(mockCoinGeckoRateLimiter.execute).toHaveBeenCalled();
    });
  });

  describe('validateToken', () => {
    it('should use crypto provider when tokenTypeCode is crypto', async () => {
      // Mock CoinGecko search + coin detail
      let callCount = 0;
      globalThis.fetch = mock(() => {
        callCount++;
        if (callCount === 1) {
          // Search response
          return Promise.resolve(
            new Response(
              JSON.stringify({
                coins: [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }],
              }),
              { status: 200 }
            )
          );
        }
        // Coin detail response
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'bitcoin',
              symbol: 'btc',
              name: 'Bitcoin',
              market_data: { current_price: { usd: 50000 } },
            }),
            { status: 200 }
          )
        );
      }) as typeof fetch;

      const result = await service.validateToken('btc', 'crypto');

      expect(result.isValid).toBe(true);
      expect(result.metadata!.type).toBe('Crypto');
      // Should use CoinGecko rate limiter
      expect(mockCoinGeckoRateLimiter.execute).toHaveBeenCalled();
    });

    it('should use Finnhub when tokenTypeCode is stock', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              c: 150.0, // current price
              d: 2.5,
              dp: 1.5,
              h: 152,
              l: 148,
              o: 149,
              pc: 147.5,
            }),
            { status: 200 }
          )
        )
      ) as typeof fetch;

      const result = await service.validateToken('AAPL', 'stock');

      expect(result.isValid).toBe(true);
      expect(result.metadata!.provider).toBe('finnhub');
      expect(mockFinnhubRateLimiter.execute).toHaveBeenCalled();
    });

    it('should try Finnhub first then CoinGecko when type is unknown', async () => {
      // First call is Finnhub quote - fails (no current price)
      let callCount = 0;
      globalThis.fetch = mock(() => {
        callCount++;
        if (callCount === 1) {
          // Finnhub quote returns 0 price (not found)
          return Promise.resolve(
            new Response(JSON.stringify({ c: 0, d: 0, dp: 0 }), { status: 200 })
          );
        }
        if (callCount === 2) {
          // CoinGecko search
          return Promise.resolve(
            new Response(
              JSON.stringify({
                coins: [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }],
              }),
              { status: 200 }
            )
          );
        }
        // CoinGecko coin detail
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'bitcoin',
              symbol: 'btc',
              name: 'Bitcoin',
            }),
            { status: 200 }
          )
        );
      }) as typeof fetch;

      const result = await service.validateToken('btc');

      expect(result.isValid).toBe(true);
      expect(result.metadata!.provider).toBe('coingecko');
    });

    it('should return invalid when both providers fail', async () => {
      // Finnhub returns no price, CoinGecko returns no matches
      let callCount = 0;
      globalThis.fetch = mock(() => {
        callCount++;
        if (callCount === 1) {
          // Finnhub: no price
          return Promise.resolve(new Response(JSON.stringify({ c: 0 }), { status: 200 }));
        }
        // CoinGecko search: no matches
        return Promise.resolve(new Response(JSON.stringify({ coins: [] }), { status: 200 }));
      }) as typeof fetch;

      const result = await service.validateToken('ZZZZZ');

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('not found in any supported provider');
    });
  });

  describe('searchFinnhubTokens', () => {
    it('should return search results from Finnhub', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              count: 2,
              result: [
                {
                  description: 'Apple Inc.',
                  displaySymbol: 'AAPL',
                  symbol: 'AAPL',
                  type: 'Common Stock',
                },
                {
                  description: 'Alphabet Inc.',
                  displaySymbol: 'GOOG',
                  symbol: 'GOOG',
                  type: 'Common Stock',
                },
              ],
            }),
            { status: 200 }
          )
        )
      ) as typeof fetch;

      const results = await service.searchFinnhubTokens('apple');

      expect(results).toHaveLength(2);
      expect(results[0]!.isValid).toBe(true);
      expect(results[0]!.metadata!.symbol).toBe('AAPL');
      expect(results[0]!.metadata!.name).toBe('Apple Inc.');
      expect(results[0]!.metadata!.provider).toBe('finnhub');
    });

    it('should return empty array when Finnhub API key missing', async () => {
      // Override config to remove API key
      const origConfig = (await import('../config/pricing')).config;
      const origKey = origConfig.finnhub.apiKey;
      (origConfig.finnhub as any).apiKey = '';

      const freshService = new TokenValidationService();
      const results = await freshService.searchFinnhubTokens('AAPL');

      expect(results).toHaveLength(0);

      // Restore
      (origConfig.finnhub as any).apiKey = origKey;
    });

    it('should limit results to 10', async () => {
      const manyResults = Array.from({ length: 20 }, (_, i) => ({
        description: `Company ${i}`,
        displaySymbol: `SYM${i}`,
        symbol: `SYM${i}`,
        type: 'Common Stock',
      }));

      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ count: 20, result: manyResults }), { status: 200 })
        )
      ) as typeof fetch;

      const results = await service.searchFinnhubTokens('test');

      expect(results.length).toBeLessThanOrEqual(10);
    });

    it('should classify ETF type correctly', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              count: 1,
              result: [
                {
                  description: 'Vanguard ETF',
                  displaySymbol: 'VTI',
                  symbol: 'VTI',
                  type: 'ETF',
                },
              ],
            }),
            { status: 200 }
          )
        )
      ) as typeof fetch;

      const results = await service.searchFinnhubTokens('VTI');

      expect(results[0]!.metadata!.type).toBe('ETF');
    });

    it('should return empty array on API error', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('Error', { status: 500, statusText: 'Server Error' }))
      ) as typeof fetch;

      const results = await service.searchFinnhubTokens('AAPL');

      expect(results).toHaveLength(0);
    });
  });

  describe('searchCoinGeckoTokens', () => {
    it('should return search results from CoinGecko', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              coins: [
                {
                  id: 'bitcoin',
                  symbol: 'btc',
                  name: 'Bitcoin',
                  large: 'https://example.com/btc.png',
                },
                { id: 'ethereum', symbol: 'eth', name: 'Ethereum' },
              ],
            }),
            { status: 200 }
          )
        )
      ) as typeof fetch;

      const results = await service.searchCoinGeckoTokens('bitcoin');

      expect(results).toHaveLength(2);
      expect(results[0]!.isValid).toBe(true);
      expect(results[0]!.metadata!.symbol).toBe('BTC');
      expect(results[0]!.metadata!.type).toBe('Crypto');
      expect(results[0]!.metadata!.provider).toBe('coingecko');
    });

    it('should return empty array on API error', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('Error', { status: 500, statusText: 'Server Error' }))
      ) as typeof fetch;

      const results = await service.searchCoinGeckoTokens('test');

      expect(results).toHaveLength(0);
    });

    it('should limit results to 10', async () => {
      const manyCoins = Array.from({ length: 20 }, (_, i) => ({
        id: `coin-${i}`,
        symbol: `c${i}`,
        name: `Coin ${i}`,
      }));

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ coins: manyCoins }), { status: 200 }))
      ) as typeof fetch;

      const results = await service.searchCoinGeckoTokens('coin');

      expect(results.length).toBeLessThanOrEqual(10);
    });

    it('should handle empty search results', async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ coins: [] }), { status: 200 }))
      ) as typeof fetch;

      const results = await service.searchCoinGeckoTokens('zzzznonexistent');

      expect(results).toHaveLength(0);
    });
  });

  describe('validateTokenByContractAddress', () => {
    it('should validate a token by contract address using DeFiLlama', async () => {
      mockFetchWithTimeout.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              coins: {
                'ethereum:0xdead': {
                  decimals: 18,
                  symbol: 'TEST',
                  price: 1.5,
                  timestamp: Date.now(),
                  confidence: 0.99,
                },
              },
            }),
            { status: 200 }
          )
        )
      );

      const result = await service.validateTokenByContractAddress('0xdead', 1);

      expect(result.isValid).toBe(true);
      expect(result.metadata!.symbol).toBe('TEST');
      expect(result.metadata!.provider).toBe('defillama');
    });

    it('should return invalid for unsupported chain', async () => {
      const result = await service.validateTokenByContractAddress('0xdead', 99999);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('not supported by DeFiLlama');
    });

    it('should return invalid for low confidence score', async () => {
      mockFetchWithTimeout.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              coins: {
                'ethereum:0xdead': {
                  decimals: 18,
                  symbol: 'LOWCONF',
                  price: 1.0,
                  timestamp: Date.now(),
                  confidence: 0.5, // Below DEFILLAMA_MIN_CONFIDENCE of 0.9
                },
              },
            }),
            { status: 200 }
          )
        )
      );

      const result = await service.validateTokenByContractAddress('0xdead', 1);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Low confidence');
    });

    it('should return invalid when token not found on DeFiLlama', async () => {
      mockFetchWithTimeout.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ coins: {} }), { status: 200 }))
      );

      const result = await service.validateTokenByContractAddress('0xnotfound', 1);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('not found on DeFiLlama');
    });

    it('should return invalid for zero/null price', async () => {
      mockFetchWithTimeout.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              coins: {
                'ethereum:0xdead': {
                  decimals: 18,
                  symbol: 'NOPRICE',
                  price: 0,
                  timestamp: Date.now(),
                  confidence: 0.99,
                },
              },
            }),
            { status: 200 }
          )
        )
      );

      const result = await service.validateTokenByContractAddress('0xdead', 1);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('No valid price');
    });
  });
});
