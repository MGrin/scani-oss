process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterAll, describe, expect, test } from 'bun:test';
import type { NewToken, Token } from '@scani/db/schema';
import { Container } from 'typedi';
import { TokenTypeRepository } from '../../../src/repositories/EnumRepositories';
import { TokenPriceRepository } from '../../../src/repositories/TokenPriceRepository';
import { TokenRepository } from '../../../src/repositories/TokenRepository';
import { TokenIdentityService } from '../../../src/services/tokens/TokenIdentityService';
import { TokenService } from '../../../src/services/tokens/TokenService';

// Stubs leak across files because typedi's Container is process-global.
// Restore real @Service() instances after the suite.
afterAll(() => {
  Container.set(TokenRepository, new TokenRepository());
  Container.set(TokenPriceRepository, new TokenPriceRepository());
  Container.set(TokenTypeRepository, new TokenTypeRepository());
  Container.set(TokenIdentityService, new TokenIdentityService());
  Container.set(TokenService, new TokenService());
});

function makeToken(): Token {
  return {
    id: 'token-canonical',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    typeId: 'stock-type',
    decimals: 2,
    marketSegment: 'US',
    iconUrl: null,
    providerMetadata: {},
    isScamProbability: 0,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Token;
}

// Captures the partial findOrCreateByIdentity was called with so the
// test can assert marketSegment survived the projection → service hop.
function makeIdentityStub(): { service: TokenIdentityService; calls: Partial<NewToken>[] } {
  const calls: Partial<NewToken>[] = [];
  const service = {
    findOrCreateByIdentity: async (partial: Partial<NewToken>) => {
      calls.push(partial);
      return makeToken();
    },
  } as unknown as TokenIdentityService;
  return { service, calls };
}

function makeTokenService(identity: TokenIdentityService): TokenService {
  Container.set(TokenRepository, {} as unknown as TokenRepository);
  Container.set(TokenPriceRepository, {} as unknown as TokenPriceRepository);
  Container.set(TokenTypeRepository, {} as unknown as TokenTypeRepository);
  Container.set(TokenIdentityService, identity);
  const instance = new TokenService();
  Container.set(TokenService, instance);
  return instance;
}

describe('TokenService.findOrCreateTokenFromIntegration — marketSegment forwarding', () => {
  test('forwards a non-null marketSegment into findOrCreateByIdentity', async () => {
    const { service, calls } = makeIdentityStub();
    const svc = makeTokenService(service);

    await svc.findOrCreateTokenFromIntegration(
      {
        token: {
          symbol: 'AAPL',
          name: 'Apple Inc.',
          typeId: 'stock-type',
          decimals: 2,
          marketSegment: 'US',
          providerMetadata: { ibkr: { symbol: 'AAPL', listingExchange: 'NASDAQ' } },
        },
        isNew: false,
        confidence: 1,
      },
      'stock-type'
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.marketSegment).toBe('US');
  });

  test('omits marketSegment when the mapping carries none', async () => {
    const { service, calls } = makeIdentityStub();
    const svc = makeTokenService(service);

    await svc.findOrCreateTokenFromIntegration(
      {
        token: {
          symbol: 'AAPL',
          name: 'Apple Inc.',
          typeId: 'stock-type',
          decimals: 2,
        },
        isNew: false,
        confidence: 1,
      },
      'stock-type'
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.marketSegment).toBeUndefined();
  });
});
