process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterAll, describe, expect, test } from 'bun:test';
import type { TokenPriceGranularity } from '@scani/db/schema';
import { Container } from 'typedi';
import { TokenPriceRepository } from '../../../src/repositories/TokenPriceRepository';
import { TokenRepository } from '../../../src/repositories/TokenRepository';
import { CurrencyConverter } from '../../../src/services/pricing/CurrencyConverter';
import { PriceGraphService } from '../../../src/services/pricing/PriceGraphService';

// Restore real instances on teardown — Container is process-global, so
// a later DB-backed test in the same `bun test` run must see the real
// @Service() registrations.
afterAll(() => {
  Container.set(TokenRepository, new TokenRepository());
  Container.set(TokenPriceRepository, new TokenPriceRepository());
  Container.set(PriceGraphService, new PriceGraphService());
  Container.set(CurrencyConverter, new CurrencyConverter());
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

function makeConverter(edges: Edge[], symbols: Record<string, string>): CurrencyConverter {
  Container.set(TokenPriceRepository, makeTokenPriceStub(edges));
  Container.set(TokenRepository, makeTokenStub(symbols));
  Container.set(PriceGraphService, new PriceGraphService());
  const instance = new CurrencyConverter();
  Container.set(CurrencyConverter, instance);
  return instance;
}

describe('CurrencyConverter.getRate — DB lookup via PriceGraphService', () => {
  const SYMBOLS = { USD: 'tok-USD', EUR: 'tok-EUR', GBP: 'tok-GBP', USDT: 'tok-USDT' };

  test('identity returns 1 for same currency', async () => {
    const c = makeConverter([], SYMBOLS);
    expect(await c.getRate('USD', 'USD', new Date(), true)).toBe('1');
  });

  test('resolves the reverse direction that forex-backfill actually stores', async () => {
    // forex-backfill stores `(EUR -> USD = 1.08)` — never the reverse.
    // The old `findLatestPrice(USD, EUR)` lookup always missed and forced
    // a live exchangerate-api call. This is the regression test for that
    // failure mode: cacheOnly=true must succeed off the DB alone.
    const at = new Date('2024-06-15T12:00:00Z');
    const c = makeConverter(
      [
        {
          tokenId: SYMBOLS.EUR,
          baseTokenId: SYMBOLS.USD,
          price: '1.08',
          timestamp: new Date('2024-06-15T03:30:00Z'),
        },
      ],
      SYMBOLS
    );
    const rate = await c.getRate('USD', 'EUR', at, true);
    expect(rate).not.toBeNull();
    // 1 / 1.08 ≈ 0.9259…
    expect(Number(rate)).toBeCloseTo(0.9259, 4);
  });

  test('cross-fiat routing via the USD hub', async () => {
    // EUR -> GBP has no direct edge; both legs live as `(X -> USD)`.
    // Must hop via USD: (EUR -> USD = 1.08) inverted on the second leg
    // (GBP -> USD = 1.27) → EUR/GBP = 1.08 / 1.27 ≈ 0.8504.
    const at = new Date('2024-06-15T12:00:00Z');
    const c = makeConverter(
      [
        {
          tokenId: SYMBOLS.EUR,
          baseTokenId: SYMBOLS.USD,
          price: '1.08',
          timestamp: new Date('2024-06-15T03:30:00Z'),
        },
        {
          tokenId: SYMBOLS.GBP,
          baseTokenId: SYMBOLS.USD,
          price: '1.27',
          timestamp: new Date('2024-06-15T03:30:00Z'),
        },
      ],
      SYMBOLS
    );
    const rate = await c.getRate('EUR', 'GBP', at, true);
    expect(rate).not.toBeNull();
    expect(Number(rate)).toBeCloseTo(0.8504, 4);
  });

  test('returns null when DB has no path and cacheOnly=true (no live API)', async () => {
    const at = new Date('2024-06-15T12:00:00Z');
    const c = makeConverter([], SYMBOLS);
    expect(await c.getRate('USD', 'EUR', at, true)).toBeNull();
  });

  test('returns null when the only DB rate is older than 24h (forces live refresh)', async () => {
    const at = new Date('2024-06-15T12:00:00Z');
    const c = makeConverter(
      [
        {
          tokenId: SYMBOLS.EUR,
          baseTokenId: SYMBOLS.USD,
          price: '1.08',
          // 2 days old → past the 24h freshness ceiling.
          timestamp: new Date('2024-06-13T03:30:00Z'),
        },
      ],
      SYMBOLS
    );
    expect(await c.getRate('USD', 'EUR', at, true)).toBeNull();
  });
});

describe('CurrencyConverter.convert', () => {
  const SYMBOLS = { USD: 'tok-USD', EUR: 'tok-EUR', USDT: 'tok-USDT' };

  test('converts via reverse-direction DB rate (the regression case)', async () => {
    const at = new Date('2024-06-15T12:00:00Z');
    const c = makeConverter(
      [
        {
          tokenId: SYMBOLS.EUR,
          baseTokenId: SYMBOLS.USD,
          price: '1.08',
          timestamp: new Date('2024-06-15T03:30:00Z'),
        },
      ],
      SYMBOLS
    );
    // $100 worth of holdings, user just switched to EUR.
    const converted = await c.convert('100', 'USD', 'EUR', at, true);
    expect(converted).not.toBeNull();
    expect(Number(converted)).toBeCloseTo(92.59, 2);
  });

  test('converts USDT to EUR via USD hub', async () => {
    const at = new Date('2024-06-15T12:00:00Z');
    const c = makeConverter(
      [
        {
          tokenId: SYMBOLS.USDT,
          baseTokenId: SYMBOLS.USD,
          price: '1.00',
          timestamp: new Date('2024-06-15T03:30:00Z'),
        },
        {
          tokenId: SYMBOLS.EUR,
          baseTokenId: SYMBOLS.USD,
          price: '1.08',
          timestamp: new Date('2024-06-15T03:30:00Z'),
        },
      ],
      SYMBOLS
    );
    const converted = await c.convert('1000', 'USDT', 'EUR', at, true);
    expect(converted).not.toBeNull();
    // 1000 USDT × 1.00 USD/USDT × (1 / 1.08) EUR/USD ≈ 925.93 EUR
    expect(Number(converted)).toBeCloseTo(925.93, 2);
  });
});
