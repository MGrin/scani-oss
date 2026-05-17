process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterAll, describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { TokenTypeRepository } from '../../../src/repositories/EnumRepositories';
import { TokenRepository } from '../../../src/repositories/TokenRepository';
import { ScamTokenDetectionService } from '../../../src/services/tokens/ScamTokenDetectionService';
import { TokenIdentityService } from '../../../src/services/tokens/TokenIdentityService';

afterAll(() => {
  Container.set(TokenRepository, new TokenRepository());
  Container.set(TokenTypeRepository, new TokenTypeRepository());
  Container.set(ScamTokenDetectionService, new ScamTokenDetectionService());
  Container.set(TokenIdentityService, new TokenIdentityService());
});

interface TupleCall {
  symbol: string;
  typeId: string;
  marketSegment: string | null;
}

// Stubs the two repositories findOrCreateByIdentity touches before its
// 3-tuple lookup, returning a token from `findByIdentityTuple` so the
// method short-circuits there. `calls` records what the tuple lookup
// received.
function setup(): { service: TokenIdentityService; calls: TupleCall[] } {
  const calls: TupleCall[] = [];

  Container.set(TokenTypeRepository, {
    findByCode: async (code: string) => ({ id: `${code}-type-id`, code }) as never,
  } as unknown as TokenTypeRepository);

  Container.set(TokenRepository, {
    findByEvmContract: async () => null,
    findByIdentityTuple: async (symbol: string, typeId: string, marketSegment: string | null) => {
      calls.push({ symbol, typeId, marketSegment });
      return { id: 'resolved-token', symbol, typeId, marketSegment } as never;
    },
  } as unknown as TokenRepository);

  Container.set(ScamTokenDetectionService, {} as unknown as ScamTokenDetectionService);

  const service = new TokenIdentityService();
  Container.set(TokenIdentityService, service);
  return { service, calls };
}

describe('TokenIdentityService — fiat invariant nulls the market segment', () => {
  test('a fiat-coded symbol supplied with a stock segment resolves with segment=null + fiat type', async () => {
    const { service, calls } = setup();

    await service.findOrCreateByIdentity({
      symbol: 'USD',
      name: 'ProShares Ultra Semiconductors',
      typeId: 'stock-type-id',
      marketSegment: 'US',
    });

    expect(calls).toHaveLength(1);
    // typeId forced to fiat, marketSegment forced to null — so the lookup
    // resolves to the single canonical seeded fiat row.
    expect(calls[0]?.typeId).toBe('fiat-type-id');
    expect(calls[0]?.marketSegment).toBeNull();
  });

  test('a non-fiat symbol keeps its supplied market segment', async () => {
    const { service, calls } = setup();

    await service.findOrCreateByIdentity({
      symbol: 'AAPL',
      name: 'Apple Inc.',
      typeId: 'stock-type-id',
      marketSegment: 'US',
    });

    expect(calls[0]?.typeId).toBe('stock-type-id');
    expect(calls[0]?.marketSegment).toBe('US');
  });
});
