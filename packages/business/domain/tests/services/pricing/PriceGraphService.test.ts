process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterAll, describe, expect, test } from 'bun:test';
import type { TokenPriceGranularity } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { TokenPriceRepository } from '../../../src/repositories/TokenPriceRepository';
import { TokenRepository } from '../../../src/repositories/TokenRepository';
import { PriceGraphService } from '../../../src/services/pricing/PriceGraphService';

// Stubs leak across files because typedi's Container is process-global.
// After this suite, restore real @Service() instances so a later
// repo/service test that ran in the same `bun test` invocation can
// resolve the real DB-backed implementation.
afterAll(() => {
  Container.set(TokenRepository, new TokenRepository());
  Container.set(TokenPriceRepository, new TokenPriceRepository());
  Container.set(PriceGraphService, new PriceGraphService());
});

interface Edge {
  tokenId: string;
  baseTokenId: string;
  price: string;
  timestamp: Date;
}

function makeTokenPriceStub(edges: Edge[]): TokenPriceRepository {
  return {
    findClosestPriceByGranularity: async (
      tokenId: string,
      baseTokenId: string,
      timestamp: Date,
      _prefer: TokenPriceGranularity | null
    ) => {
      const match = edges
        .filter(
          (e) =>
            e.tokenId === tokenId &&
            e.baseTokenId === baseTokenId &&
            e.timestamp.getTime() <= timestamp.getTime()
        )
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];
      if (!match) return null;
      return {
        ...match,
        id: 'x',
        source: 's',
        granularity: 'daily',
        createdAt: new Date(),
      } as never;
    },
  } as unknown as TokenPriceRepository;
}

function makeTokenStub(bySymbol: Record<string, string>): TokenRepository {
  return {
    findBySymbol: async (symbol: string) => {
      const id = bySymbol[symbol];
      if (!id) return null;
      return {
        id,
        symbol,
        name: symbol,
        typeId: 't',
        decimals: 2,
        isScamProbability: 0,
        isActive: true,
        providerMetadata: '{}',
        iconUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never;
    },
  } as unknown as TokenRepository;
}

const HUB_IDS = { USD: 'token-USD', USDT: 'token-USDT', EUR: 'token-EUR' };

// Same DI pattern as BalanceAtTimeService.test — seed stubs, then
// construct a fresh instance so class-field `Container.get()` calls
// in PriceGraphService's constructor see our stubs. See the detailed
// note in BalanceAtTimeService.test about why we don't reset / remove.
function makePriceGraphService(
  tpStub: TokenPriceRepository,
  tokStub: TokenRepository
): PriceGraphService {
  Container.set(TokenPriceRepository, tpStub);
  Container.set(TokenRepository, tokStub);
  const instance = new PriceGraphService();
  Container.set(PriceGraphService, instance);
  return instance;
}

describe('PriceGraphService.convert', () => {
  test('identity when from == to', async () => {
    const svc = makePriceGraphService(makeTokenPriceStub([]), makeTokenStub(HUB_IDS));
    const r = await svc.convert('7.5', 'same', 'same', new Date());
    expect(r?.amount.toString()).toBe('7.5');
    expect(r?.rate.toString()).toBe('1');
    expect(r?.path).toBe('identity');
  });

  test('direct edge: applies rate and reports effectiveAt', async () => {
    const at = new Date('2024-06-01T00:00:00Z');
    const svc = makePriceGraphService(
      makeTokenPriceStub([
        {
          tokenId: 'BTC',
          baseTokenId: 'USD',
          price: '65000',
          timestamp: new Date('2024-05-30T00:00:00Z'),
        },
      ]),
      makeTokenStub(HUB_IDS)
    );
    const r = await svc.convert(new Decimal('2'), 'BTC', 'USD', at);
    expect(r?.amount.toString()).toBe('130000');
    expect(r?.path).toBe('direct');
    expect(r?.effectiveAt.toISOString()).toBe('2024-05-30T00:00:00.000Z');
  });

  test('reverse direct: inverts price when only to->from edge exists', async () => {
    const at = new Date('2024-06-01T00:00:00Z');
    const svc = makePriceGraphService(
      makeTokenPriceStub([
        // Only USD->BTC stored (price "USD per BTC" inversion), value = 0.00001538 BTC per USD
        {
          tokenId: 'USD',
          baseTokenId: 'BTC',
          price: '0.0000153846',
          timestamp: new Date('2024-05-30T00:00:00Z'),
        },
      ]),
      makeTokenStub(HUB_IDS)
    );
    const r = await svc.convert(new Decimal('1'), 'BTC', 'USD', at);
    // 1 / 0.0000153846 ≈ 65000.195…
    expect(r?.amount.toNumber()).toBeCloseTo(65000, 0);
    expect(r?.path).toBe('direct');
  });

  test('one-hop via USD hub when no direct edge', async () => {
    const at = new Date('2024-06-01T00:00:00Z');
    // BTC -> USD (65000), USD -> EUR (0.92). Request BTC->EUR must chain.
    const svc = makePriceGraphService(
      makeTokenPriceStub([
        {
          tokenId: 'BTC',
          baseTokenId: 'token-USD',
          price: '65000',
          timestamp: new Date('2024-05-30T00:00:00Z'),
        },
        {
          tokenId: 'token-USD',
          baseTokenId: 'EUR',
          price: '0.92',
          timestamp: new Date('2024-05-28T00:00:00Z'),
        },
      ]),
      makeTokenStub(HUB_IDS)
    );
    const r = await svc.convert('1', 'BTC', 'EUR', at);
    expect(r?.amount.toNumber()).toBeCloseTo(59800, 1);
    expect(r?.path).toBe('one-hop-token-USD');
    // effectiveAt is the older of the two legs — the weakest link.
    expect(r?.effectiveAt.toISOString()).toBe('2024-05-28T00:00:00.000Z');
  });

  test('returns null when no path exists at maxDepth=1', async () => {
    const svc = makePriceGraphService(
      makeTokenPriceStub([
        {
          tokenId: 'BTC',
          baseTokenId: 'token-USD',
          price: '65000',
          timestamp: new Date('2024-05-30T00:00:00Z'),
        },
      ]),
      makeTokenStub(HUB_IDS)
    );
    const r = await svc.convert('1', 'BTC', 'EUR', new Date('2024-06-01T00:00:00Z'), {
      maxDepth: 1,
    });
    expect(r).toBeNull();
  });

  test('returns null when no edge whatsoever', async () => {
    const svc = makePriceGraphService(makeTokenPriceStub([]), makeTokenStub(HUB_IDS));
    const r = await svc.convert('1', 'BTC', 'EUR', new Date('2024-06-01T00:00:00Z'));
    expect(r).toBeNull();
  });

  test('zero-price reverse edge is treated as unpriceable', async () => {
    const svc = makePriceGraphService(
      makeTokenPriceStub([
        {
          tokenId: 'USD',
          baseTokenId: 'BTC',
          price: '0',
          timestamp: new Date('2024-05-30T00:00:00Z'),
        },
      ]),
      makeTokenStub(HUB_IDS)
    );
    const r = await svc.convert('1', 'BTC', 'USD', new Date('2024-06-01T00:00:00Z'));
    expect(r).toBeNull();
  });
});
