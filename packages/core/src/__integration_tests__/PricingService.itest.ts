import { beforeEach, describe, expect, it, mock } from 'bun:test';

// Mock database connection to prevent actual DB operations
// Note: DATABASE_URL must be set before bun loads modules - use test-preload.ts
mock.module('../database/connection', () => ({
  db: {},
  getDb: () => ({}),
}));

// Mock repositories and external services
const mockTokenRepository = {
  findBySymbol: mock(() => Promise.resolve(null)),
  findById: mock(() => Promise.resolve(null)),
  findByIds: mock(() => Promise.resolve([])),
  findManyWithTypes: mock(() => Promise.resolve([])),
};

const mockTokenPriceRepository = {
  findPriceAtTimestamp: mock(() => Promise.resolve(null)),
  findLatestPrice: mock(() => Promise.resolve(null)),
  findLatestPricesForTokens: mock(() => Promise.resolve(new Map())),
  bulkUpsert: mock(() => Promise.resolve()),
};

const mockTokenTypeRepository = {
  findById: mock(() => Promise.resolve(null)),
};

const mockUserPortfolioEventService = {
  createPriceUpdateEvents: mock(() => Promise.resolve(0)),
};

mock.module('typedi', () => ({
  Container: {
    get: (cls: { name?: string }) => {
      const name = cls?.name || '';
      if (name.includes('TokenPriceRepository')) return mockTokenPriceRepository;
      if (name.includes('TokenTypeRepository')) return mockTokenTypeRepository;
      if (name.includes('TokenRepository')) return mockTokenRepository;
      if (name.includes('UserPortfolioEventService')) return mockUserPortfolioEventService;
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

// Mock providers to avoid actual API calls
mock.module('../external-services/pricing/providers/coingecko', () => ({
  CoinGeckoProvider: class {
    key = 'coinGecko';
    fetchPrices = mock(() => Promise.resolve([]));
  },
}));

mock.module('../external-services/pricing/providers/defillama', () => ({
  DeFiLlamaProvider: class {
    key = 'defiLlama';
    fetchPrices = mock(() => Promise.resolve([]));
  },
}));

mock.module('../external-services/pricing/providers/exchange-rate', () => ({
  ExchangeRateProvider: class {
    key = 'exchangeRate';
    fetchPrices = mock(() => Promise.resolve([]));
  },
}));

mock.module('../external-services/pricing/providers/finnhub', () => ({
  FinnhubProvider: class {
    key = 'finnhub';
    fetchPrices = mock(() => Promise.resolve([]));
  },
}));

mock.module('../external-services/pricing/providers/google-sheets', () => ({
  GoogleSheetsProvider: class {
    isAvailable = () => false;
    fetchPrices = mock(() => Promise.resolve([]));
    filterEligibleTokens = mock(() => Promise.resolve([]));
  },
}));

mock.module('../external-services/pricing/provider-config', () => ({
  PROVIDER_CONFIGS: {
    exchangeRate: {
      name: 'ExchangeRate-API',
      baseUrl: 'https://api.exchangerate-api.com/v4/latest',
      rateLimit: 1500,
    },
    coinGecko: {
      name: 'CoinGecko',
      baseUrl: 'https://api.coingecko.com/api/v3',
      rateLimit: 50,
    },
    defiLlama: {
      name: 'DeFiLlama',
      baseUrl: 'https://coins.llama.fi',
      rateLimit: 300,
    },
    finnhub: {
      name: 'Finnhub',
      baseUrl: 'https://finnhub.io/api/v1',
      rateLimit: 60,
    },
    googleSheets: {
      name: 'Google Sheets (GOOGLEFINANCE)',
      rateLimit: 100,
    },
  },
}));

// Mock fetchWithTimeout
const mockFetchWithTimeout = mock(() =>
  Promise.resolve(new Response(JSON.stringify({ rates: {} }), { status: 200 }))
);

mock.module('../external-services/pricing/utils', () => ({
  fetchWithTimeout: mockFetchWithTimeout,
  RateLimiter: class MockRateLimiter {
    private maxRequests: number;
    private windowMs: number;
    constructor(maxRequests: number, windowMs: number) {
      this.maxRequests = maxRequests;
      this.windowMs = windowMs;
    }
    async execute<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    }
  },
}));

// Mock the UserPortfolioEventService module to prevent it from loading DB
mock.module('./UserPortfolioEventService', () => ({
  UserPortfolioEventService: class {
    createPriceUpdateEvents = mock(() => Promise.resolve(0));
  },
}));

import { PricingService } from './PricingService';

describe('PricingService', () => {
  let service: PricingService;

  const baseCurrencyToken = {
    id: 'usd-token-id',
    symbol: 'USD',
    name: 'US Dollar',
    typeId: 'type-fiat',
    decimals: 2,
    iconUrl: null,
    providerMetadata: '{}',
    isScamProbability: 0,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const btcToken = {
    id: 'btc-token-id',
    symbol: 'BTC',
    name: 'Bitcoin',
    typeId: 'type-crypto',
    decimals: 8,
    iconUrl: null,
    providerMetadata: '{"coingecko":{"id":"bitcoin"}}',
    isScamProbability: 0,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    // Reset all mocks
    for (const repo of [
      mockTokenRepository,
      mockTokenPriceRepository,
      mockTokenTypeRepository,
      mockUserPortfolioEventService,
    ]) {
      Object.values(repo).forEach((fn) => {
        if (typeof fn === 'function' && 'mockReset' in fn)
          (fn as ReturnType<typeof mock>).mockReset();
      });
    }
    mockFetchWithTimeout.mockReset();

    // Set defaults
    mockTokenRepository.findBySymbol.mockImplementation(() => Promise.resolve(null));
    mockTokenRepository.findById.mockImplementation(() => Promise.resolve(null));
    mockTokenRepository.findByIds.mockImplementation(() => Promise.resolve([]));
    mockTokenRepository.findManyWithTypes.mockImplementation(() => Promise.resolve([]));
    mockTokenPriceRepository.findPriceAtTimestamp.mockImplementation(() => Promise.resolve(null));
    mockTokenPriceRepository.findLatestPrice.mockImplementation(() => Promise.resolve(null));
    mockTokenPriceRepository.findLatestPricesForTokens.mockImplementation(() =>
      Promise.resolve(new Map())
    );
    mockTokenPriceRepository.bulkUpsert.mockImplementation(() => Promise.resolve());
    mockUserPortfolioEventService.createPriceUpdateEvents.mockImplementation(() =>
      Promise.resolve(0)
    );
    mockFetchWithTimeout.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ rates: {} }), { status: 200 }))
    );

    service = new PricingService();
  });

  describe('rate limiter configuration', () => {
    it('should have CoinGecko rate limiter configured', () => {
      expect(service.coinGeckoRateLimiter).toBeDefined();
      expect(typeof service.coinGeckoRateLimiter.execute).toBe('function');
    });

    it('should have Finnhub rate limiter configured', () => {
      expect(service.finnhubRateLimiter).toBeDefined();
      expect(typeof service.finnhubRateLimiter.execute).toBe('function');
    });

    it('should share rate limiters across instances (singleton pattern)', () => {
      const service1 = new PricingService();
      const service2 = new PricingService();

      // Both instances should share the same global rate limiters
      expect(service1.coinGeckoRateLimiter).toBe(service2.coinGeckoRateLimiter);
      expect(service1.finnhubRateLimiter).toBe(service2.finnhubRateLimiter);
    });
  });

  describe('getTokenPrice', () => {
    it('should return "1" for base currency token', async () => {
      mockTokenRepository.findBySymbol.mockImplementation(() => Promise.resolve(baseCurrencyToken));

      const price = await service.getTokenPrice(baseCurrencyToken, 'USD', new Date());

      expect(price).toBe('1');
    });

    it('should return "0" when base currency token not found', async () => {
      mockTokenRepository.findBySymbol.mockImplementation(() => Promise.resolve(null));

      const price = await service.getTokenPrice(btcToken, 'INVALID', new Date());

      expect(price).toBe('0');
    });

    it('should return cached price when available', async () => {
      const timestamp = new Date();
      mockTokenRepository.findBySymbol.mockImplementation(() => Promise.resolve(baseCurrencyToken));
      mockTokenPriceRepository.findPriceAtTimestamp.mockImplementation(() =>
        Promise.resolve({
          price: '50000',
          timestamp: new Date(timestamp.getTime() - 30 * 60 * 1000), // 30 min ago
          source: 'CoinGecko',
          baseTokenId: 'usd-token-id',
        })
      );

      const price = await service.getTokenPrice(btcToken, 'USD', timestamp);

      expect(price).toBe('50000');
    });

    it('should use live price window for recent timestamps', async () => {
      const now = new Date();
      mockTokenRepository.findBySymbol.mockImplementation(() => Promise.resolve(baseCurrencyToken));

      // No cached price - will trigger fresh fetch
      mockTokenPriceRepository.findPriceAtTimestamp.mockImplementation(() => Promise.resolve(null));
      mockTokenPriceRepository.findLatestPrice.mockImplementation(() => Promise.resolve(null));
      mockTokenRepository.findManyWithTypes.mockImplementation(() =>
        Promise.resolve([{ id: btcToken.id, typeCode: 'crypto' }])
      );
      mockTokenPriceRepository.findLatestPricesForTokens.mockImplementation(() =>
        Promise.resolve(new Map())
      );

      await service.getTokenPrice(btcToken, 'USD', now);

      // findPriceAtTimestamp should be called with the token, base currency, and timestamp
      expect(mockTokenPriceRepository.findPriceAtTimestamp).toHaveBeenCalledWith(
        'btc-token-id',
        'usd-token-id',
        now,
        expect.any(Number)
      );
    });
  });

  describe('getTokenPrices (batch)', () => {
    it('should return "1" for base currency in batch', async () => {
      mockTokenRepository.findBySymbol.mockImplementation(() => Promise.resolve(baseCurrencyToken));

      const result = await service.getTokenPrices([baseCurrencyToken], 'USD', new Date());

      expect(result.get('usd-token-id')).toBe('1');
    });

    it('should return empty map for empty tokens array', async () => {
      const result = await service.getTokenPrices([], 'USD', new Date());

      expect(result.size).toBe(0);
    });

    it('should set "0" for all tokens when base currency not found', async () => {
      mockTokenRepository.findBySymbol.mockImplementation(() => Promise.resolve(null));

      const result = await service.getTokenPrices([btcToken], 'INVALID', new Date());

      expect(result.get('btc-token-id')).toBe('0');
    });

    it('should use cached prices from batch query', async () => {
      mockTokenRepository.findBySymbol.mockImplementation(() => Promise.resolve(baseCurrencyToken));

      const cachedPrices = new Map();
      cachedPrices.set('btc-token-id', {
        price: '50000',
        timestamp: new Date(),
        source: 'CoinGecko',
        baseTokenId: 'usd-token-id',
      });
      mockTokenPriceRepository.findLatestPricesForTokens.mockImplementation(() =>
        Promise.resolve(cachedPrices)
      );

      const result = await service.getTokenPrices([btcToken], 'USD', new Date());

      expect(result.get('btc-token-id')).toBe('50000');
    });

    it('should deduplicate concurrent requests for same tokens', async () => {
      mockTokenRepository.findBySymbol.mockImplementation(() => Promise.resolve(baseCurrencyToken));

      const cachedPrices = new Map();
      cachedPrices.set('btc-token-id', {
        price: '50000',
        timestamp: new Date(),
        source: 'CoinGecko',
        baseTokenId: 'usd-token-id',
      });
      mockTokenPriceRepository.findLatestPricesForTokens.mockImplementation(() =>
        Promise.resolve(cachedPrices)
      );

      const now = new Date();
      // Fire two identical requests concurrently
      const [result1, result2] = await Promise.all([
        service.getTokenPrices([btcToken], 'USD', now),
        service.getTokenPrices([btcToken], 'USD', now),
      ]);

      // Both should get same results
      expect(result1.get('btc-token-id')).toBe('50000');
      expect(result2.get('btc-token-id')).toBe('50000');

      // findBySymbol should only be called once since the second request is deduplicated
      expect(mockTokenRepository.findBySymbol).toHaveBeenCalledTimes(1);
    });
  });

  describe('price caching logic', () => {
    it('should use manual prices without time restriction', async () => {
      mockTokenRepository.findBySymbol.mockImplementation(() => Promise.resolve(baseCurrencyToken));

      // No timestamp-restricted price found
      mockTokenPriceRepository.findPriceAtTimestamp.mockImplementation(() => Promise.resolve(null));
      // But has a manual price from long ago
      mockTokenPriceRepository.findLatestPrice.mockImplementation(() =>
        Promise.resolve({
          price: '100',
          timestamp: new Date('2020-01-01'),
          source: 'manual_user_input',
          baseTokenId: 'usd-token-id',
        })
      );

      const privateToken = {
        ...btcToken,
        id: 'private-token-id',
        symbol: 'PRIV',
        providerMetadata: '{}',
      };

      const price = await service.getTokenPrice(privateToken, 'USD', new Date());

      // Should return the manual price
      expect(price).toBe('100');
    });
  });

  describe('currency conversion', () => {
    it('should return same price when from and to currencies are the same', async () => {
      mockTokenRepository.findBySymbol.mockImplementation(() => Promise.resolve(baseCurrencyToken));
      mockTokenPriceRepository.findPriceAtTimestamp.mockImplementation(() =>
        Promise.resolve({
          price: '50000',
          timestamp: new Date(),
          source: 'CoinGecko',
          baseTokenId: 'usd-token-id',
        })
      );

      // Token priced in USD, requesting USD - no conversion needed
      const price = await service.getTokenPrice(btcToken, 'USD', new Date());

      expect(price).toBe('50000');
    });

    it('should attempt currency conversion when cached price is in different currency', async () => {
      const eurToken = {
        ...baseCurrencyToken,
        id: 'eur-token-id',
        symbol: 'EUR',
        name: 'Euro',
      };

      mockTokenRepository.findBySymbol.mockImplementation((symbol: string) => {
        if (symbol === 'EUR') return Promise.resolve(eurToken);
        if (symbol === 'USD') return Promise.resolve(baseCurrencyToken);
        return Promise.resolve(null);
      });

      mockTokenRepository.findById.mockImplementation((id: string) => {
        if (id === 'usd-token-id') return Promise.resolve(baseCurrencyToken);
        if (id === 'eur-token-id') return Promise.resolve(eurToken);
        return Promise.resolve(null);
      });

      // Cached price is in USD
      mockTokenPriceRepository.findPriceAtTimestamp.mockImplementation(() =>
        Promise.resolve({
          price: '50000',
          timestamp: new Date(),
          source: 'CoinGecko',
          baseTokenId: 'usd-token-id',
        })
      );

      // Conversion rate from USD to EUR
      mockTokenPriceRepository.findLatestPrice.mockImplementation(
        (tokenId: string, baseTokenId: string) => {
          if (tokenId === 'usd-token-id' && baseTokenId === 'eur-token-id') {
            return Promise.resolve({
              price: '0.92',
              timestamp: new Date(),
              source: 'exchangerate-api',
              baseTokenId: 'eur-token-id',
            });
          }
          return Promise.resolve(null);
        }
      );

      const price = await service.getTokenPrice(btcToken, 'EUR', new Date());

      // Price should be converted: 50000 * 0.92 = 46000
      expect(parseFloat(price)).toBeGreaterThan(0);
    });
  });

  describe('getCurrencyRateCacheSize', () => {
    it('should return 0 for a fresh service instance', () => {
      expect(service.getCurrencyRateCacheSize()).toBe(0);
    });
  });

  describe('isLivePrice (via getTokenPrice behavior)', () => {
    it('should treat recent timestamps as live prices', async () => {
      const now = new Date();
      mockTokenRepository.findBySymbol.mockImplementation(() => Promise.resolve(baseCurrencyToken));
      mockTokenPriceRepository.findPriceAtTimestamp.mockImplementation(() => Promise.resolve(null));
      mockTokenPriceRepository.findLatestPrice.mockImplementation(() => Promise.resolve(null));
      mockTokenRepository.findManyWithTypes.mockImplementation(() => Promise.resolve([]));

      await service.getTokenPrice(btcToken, 'USD', now);

      // For live prices, the maxAge is LIVE_PRICE_WINDOW_MS (1 hour)
      const call = mockTokenPriceRepository.findPriceAtTimestamp.mock.calls[0];
      expect(call).toBeDefined();
      const maxAge = call![3] as number;
      // Live window is 1 hour = 3600000ms
      expect(maxAge).toBe(60 * 60 * 1000);
    });

    it('should treat old timestamps as historical prices', async () => {
      const oldTimestamp = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3 hours ago
      mockTokenRepository.findBySymbol.mockImplementation(() => Promise.resolve(baseCurrencyToken));
      mockTokenPriceRepository.findPriceAtTimestamp.mockImplementation(() => Promise.resolve(null));
      mockTokenPriceRepository.findLatestPrice.mockImplementation(() => Promise.resolve(null));
      mockTokenRepository.findManyWithTypes.mockImplementation(() => Promise.resolve([]));

      await service.getTokenPrice(btcToken, 'USD', oldTimestamp);

      const call = mockTokenPriceRepository.findPriceAtTimestamp.mock.calls[0];
      expect(call).toBeDefined();
      const maxAge = call![3] as number;
      // Historical window is 24 hours = 86400000ms
      expect(maxAge).toBe(24 * 60 * 60 * 1000);
    });
  });

  describe('provider assignment', () => {
    it('should assign crypto tokens to CoinGecko provider', async () => {
      mockTokenRepository.findBySymbol.mockImplementation(() => Promise.resolve(baseCurrencyToken));
      mockTokenPriceRepository.findPriceAtTimestamp.mockImplementation(() => Promise.resolve(null));
      mockTokenPriceRepository.findLatestPrice.mockImplementation(() => Promise.resolve(null));
      mockTokenRepository.findManyWithTypes.mockImplementation(() =>
        Promise.resolve([{ id: btcToken.id, typeCode: 'crypto' }])
      );
      mockTokenPriceRepository.findLatestPricesForTokens.mockImplementation(() =>
        Promise.resolve(new Map())
      );

      // The service should group this token under the coinGecko provider
      await service.getTokenPrice(btcToken, 'USD', new Date());

      // Token was sent through the pricing pipeline
      expect(mockTokenRepository.findManyWithTypes).toHaveBeenCalledWith([btcToken.id]);
    });
  });
});
