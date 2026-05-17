process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterAll, describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { TokenTypeRepository } from '../../../src/repositories/EnumRepositories';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { TokenRepository } from '../../../src/repositories/TokenRepository';
import { EnrichHoldingsService } from '../../../src/services/holdings/EnrichHoldingsService';

// Stubs leak across files because typedi's Container is process-global.
// Restore real @Service() instances after this suite.
afterAll(() => {
  Container.set(TokenRepository, new TokenRepository());
  Container.set(HoldingRepository, new HoldingRepository());
  Container.set(TokenTypeRepository, new TokenTypeRepository());
  Container.set(EnrichHoldingsService, new EnrichHoldingsService());
});

interface SetupOpts {
  /** Keyed `${SYMBOL}:${typeId}` → token row (or null = miss). */
  bySymbolAndType?: Record<string, { id: string } | null>;
  /** Keyed `SYMBOL` → token row returned by the type-blind lookup. */
  bySymbol?: Record<string, { id: string } | null>;
}

function setup(opts: SetupOpts): EnrichHoldingsService {
  Container.set(TokenTypeRepository, {
    findByCode: async (code: string) => ({ id: `${code}-type-id`, code }) as never,
  } as unknown as TokenTypeRepository);

  Container.set(TokenRepository, {
    findBySymbolAndType: async (symbol: string, typeId: string) =>
      (opts.bySymbolAndType?.[`${symbol.toUpperCase()}:${typeId}`] ?? null) as never,
    findBySymbol: async (symbol: string) =>
      (opts.bySymbol?.[symbol.toUpperCase()] ?? null) as never,
  } as unknown as TokenRepository);

  Container.set(HoldingRepository, {
    findByUserWithFullDetails: async () => [],
  } as unknown as HoldingRepository);

  const service = new EnrichHoldingsService();
  Container.set(EnrichHoldingsService, service);
  return service;
}

describe('EnrichHoldingsService — type-aware token resolution', () => {
  test('a fiat-classified holding resolves to the fiat token, not a same-named stock', async () => {
    // USD exists as both a fiat row and a stock-ticker row; the
    // type-blind findBySymbol returns the stock one.
    const service = setup({
      bySymbolAndType: { 'USD:fiat-type-id': { id: 'fiat-usd-token' } },
      bySymbol: { USD: { id: 'stock-usd-token' } },
    });

    const [enriched] = await service.enrich({
      holdings: [{ symbol: 'USD', assetType: 'fiat', balance: '100', confidence: 0.9 }],
      userId: 'u1',
    });

    expect(enriched?.tokenId).toBe('fiat-usd-token');
  });

  test('an unclassified holding still resolves via the type-blind lookup', async () => {
    const service = setup({
      bySymbolAndType: { 'USD:fiat-type-id': { id: 'fiat-usd-token' } },
      bySymbol: { USD: { id: 'stock-usd-token' } },
    });

    const [enriched] = await service.enrich({
      holdings: [{ symbol: 'USD', balance: '100', confidence: 0.9 }],
      userId: 'u1',
    });

    expect(enriched?.tokenId).toBe('stock-usd-token');
  });

  test('falls back to the type-blind lookup when no typed row exists', async () => {
    const service = setup({
      bySymbolAndType: {}, // no fiat-typed USD row
      bySymbol: { USD: { id: 'stock-usd-token' } },
    });

    const [enriched] = await service.enrich({
      holdings: [{ symbol: 'USD', assetType: 'fiat', balance: '100', confidence: 0.9 }],
      userId: 'u1',
    });

    expect(enriched?.tokenId).toBe('stock-usd-token');
  });

  test('preserves assetType on the enriched holding', async () => {
    const service = setup({
      bySymbolAndType: { 'BTC:crypto-type-id': { id: 'btc-token' } },
    });

    const [enriched] = await service.enrich({
      holdings: [{ symbol: 'BTC', assetType: 'crypto', balance: '1', confidence: 0.95 }],
      userId: 'u1',
    });

    expect(enriched?.assetType).toBe('crypto');
    expect(enriched?.tokenId).toBe('btc-token');
  });
});
