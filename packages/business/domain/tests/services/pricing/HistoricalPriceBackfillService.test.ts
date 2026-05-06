process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterAll, describe, expect, test } from 'bun:test';
import type { Token } from '@scani/db/schema';
import type { HistoricalPriceProvider } from '@scani/providers/core/capabilities';
import { ProviderRegistry } from '@scani/providers/core/registry';
import type { PriceQuote } from '@scani/providers/core/types';
import { Container } from 'typedi';
import { TokenPriceRepository } from '../../../src/repositories/TokenPriceRepository';
import { TokenRepository } from '../../../src/repositories/TokenRepository';
import { HistoricalPriceBackfillService } from '../../../src/services/pricing/HistoricalPriceBackfillService';

// Stubs leak across files because typedi's Container is process-global.
// After this suite, restore real @Service() instances so a later
// repo/service test that ran in the same `bun test` invocation can
// resolve the real DB-backed implementation.
afterAll(() => {
  Container.set(TokenRepository, new TokenRepository());
  Container.set(TokenPriceRepository, new TokenPriceRepository());
  Container.set(ProviderRegistry, new ProviderRegistry());
  Container.set(HistoricalPriceBackfillService, new HistoricalPriceBackfillService());
});

function makeToken(id: string, symbol = id): Token {
  return {
    id,
    symbol,
    name: symbol,
    typeId: 'crypto',
    decimals: 18,
    iconUrl: null,
    providerMetadata: {},
    isScamProbability: 0,
    isActive: true,
    marketSegment: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

interface CapturedUpsert {
  tokenId: string;
  baseTokenId: string;
  price: string;
  timestamp: Date;
  source: string;
}

function makeService(opts: {
  tokens: Map<string, Token>;
  existingPriceForToken?: {
    tokenId: string;
    baseTokenId: string;
    at: Date;
    price: string;
    source: string;
  };
  pricers: HistoricalPriceProvider[];
}): {
  service: HistoricalPriceBackfillService;
  captured: CapturedUpsert[];
} {
  const captured: CapturedUpsert[] = [];

  Container.set(TokenRepository, {
    findById: async (id: string) => (opts.tokens.get(id) as never) ?? null,
    // findWithType is what backfill actually uses for the token-being-priced
    // (so the equity-only-provider filter can read typeCode). Tests don't
    // need a real type here — null typeCode keeps every provider in scope.
    findWithType: async (id: string) => {
      const t = opts.tokens.get(id);
      return t ? ({ ...t, typeCode: null } as never) : null;
    },
  } as unknown as TokenRepository);

  Container.set(TokenPriceRepository, {
    findClosestPriceByGranularity: async (tokenId: string, baseTokenId: string, at: Date) => {
      const e = opts.existingPriceForToken;
      if (!e) return null;
      if (e.tokenId !== tokenId || e.baseTokenId !== baseTokenId) return null;
      // Only return when the cached price is within 24h of `at` (mirrors
      // the service's freshness gate).
      if (Math.abs(e.at.getTime() - at.getTime()) > 24 * 60 * 60 * 1000) return null;
      return {
        tokenId,
        baseTokenId,
        price: e.price,
        timestamp: e.at,
        source: e.source,
      } as never;
    },
    bulkUpsertDailyBackfill: async (rows: CapturedUpsert[]) => {
      captured.push(...rows);
      return rows as never;
    },
  } as unknown as TokenPriceRepository);

  const registry = new ProviderRegistry();
  for (const p of opts.pricers) registry.register(p);
  Container.set(ProviderRegistry, registry);

  const service = new HistoricalPriceBackfillService();
  Container.set(HistoricalPriceBackfillService, service);
  return { service, captured };
}

function makePricer(opts: {
  providerKey: string;
  matches: (t: Token) => boolean;
  result: PriceQuote | null;
}): HistoricalPriceProvider {
  return {
    providerKey: opts.providerKey,
    capabilities: ['historical-price'],
    canPrice: opts.matches,
    fetchCurrentPrice: async () => null,
    fetchHistoricalPrice: async () => opts.result,
  };
}

describe('HistoricalPriceBackfillService.backfillOne', () => {
  test('returns no-provider when token or baseToken cannot be resolved', async () => {
    const { service } = makeService({ tokens: new Map(), pricers: [] });
    const r = await service.backfillOne('missing', new Date(), 'usd');
    expect(r.status).toBe('no-provider');
  });

  test('returns already-have when a recent daily price is cached', async () => {
    const tokens = new Map<string, Token>();
    tokens.set('btc', makeToken('btc', 'BTC'));
    tokens.set('usd', makeToken('usd', 'USD'));
    const at = new Date('2024-01-15T00:00:00Z');
    const { service, captured } = makeService({
      tokens,
      existingPriceForToken: {
        tokenId: 'btc',
        baseTokenId: 'usd',
        at,
        price: '42000',
        source: 'coingecko_cached',
      },
      pricers: [],
    });
    const r = await service.backfillOne('btc', at, 'usd');
    expect(r.status).toBe('already-have');
    expect(r.priceStored).toBe('42000');
    expect(captured).toHaveLength(0);
  });

  test('returns provider-missing when no historical pricer claims the token', async () => {
    const tokens = new Map<string, Token>();
    tokens.set('btc', makeToken('btc', 'BTC'));
    tokens.set('usd', makeToken('usd', 'USD'));
    const { service, captured } = makeService({
      tokens,
      pricers: [
        makePricer({
          providerKey: 'pricer-eth-only',
          matches: (t) => t.symbol === 'ETH',
          result: null,
        }),
      ],
    });
    const r = await service.backfillOne('btc', new Date('2024-01-01'), 'usd');
    expect(r.status).toBe('provider-missing');
    expect(captured).toHaveLength(0);
  });

  test('inserts the first non-null price and returns inserted', async () => {
    const tokens = new Map<string, Token>();
    tokens.set('btc', makeToken('btc', 'BTC'));
    tokens.set('usd', makeToken('usd', 'USD'));
    const at = new Date('2024-02-01T00:00:00Z');
    const winnerQuote: PriceQuote = {
      tokenId: 'btc',
      baseTokenId: 'usd',
      price: '40000',
      timestamp: at,
      source: 'defillama_historical',
    };
    const { service, captured } = makeService({
      tokens,
      pricers: [
        makePricer({ providerKey: 'p1', matches: (t) => t.symbol === 'BTC', result: null }),
        makePricer({ providerKey: 'p2', matches: (t) => t.symbol === 'BTC', result: winnerQuote }),
        // p3 would also match but the service short-circuits on the first non-null.
        makePricer({
          providerKey: 'p3',
          matches: (t) => t.symbol === 'BTC',
          result: { ...winnerQuote, price: '99999', source: 'should-not-be-called' },
        }),
      ],
    });
    const r = await service.backfillOne('btc', at, 'usd');
    expect(r.status).toBe('inserted');
    expect(r.priceStored).toBe('40000');
    expect(r.providerUsed).toBe('p2');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.price).toBe('40000');
    expect(captured[0]?.source).toBe('defillama_historical');
  });

  test('continues past pricers that throw and tries the next one', async () => {
    const tokens = new Map<string, Token>();
    tokens.set('btc', makeToken('btc', 'BTC'));
    tokens.set('usd', makeToken('usd', 'USD'));
    const at = new Date('2024-03-01T00:00:00Z');
    const winnerQuote: PriceQuote = {
      tokenId: 'btc',
      baseTokenId: 'usd',
      price: '50000',
      timestamp: at,
      source: 'fallback',
    };
    const { service, captured } = makeService({
      tokens,
      pricers: [
        {
          providerKey: 'throws',
          capabilities: ['historical-price'],
          canPrice: () => true,
          fetchCurrentPrice: async () => null,
          fetchHistoricalPrice: async () => {
            throw new Error('upstream 500');
          },
        },
        makePricer({ providerKey: 'fallback', matches: () => true, result: winnerQuote }),
      ],
    });
    const r = await service.backfillOne('btc', at, 'usd');
    expect(r.status).toBe('inserted');
    expect(r.providerUsed).toBe('fallback');
    expect(captured).toHaveLength(1);
  });
});
