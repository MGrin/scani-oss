process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { TokenTypeRepository } from '../../../src/repositories/EnumRepositories';
import { TokenRepository } from '../../../src/repositories/TokenRepository';
import { ScamTokenDetectionService } from '../../../src/services/tokens/ScamTokenDetectionService';
import {
  ScamTokenRejectedError,
  TokenIdentityService,
} from '../../../src/services/tokens/TokenIdentityService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

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

/**
 * SC-197. Ten tokens with lookalike symbols reached production, and the
 * two treatments here are deliberately different:
 *
 *   - an attack NAME is refused outright — there is no reading of
 *     `✅ SWAP YOUR VOUCHER ON T.LY/SHIBASWAP` that is a token identity;
 *   - a lookalike SYMBOL is CREATED and permanently marked, because the
 *     danger is that the row is indistinguishable from the real one, and
 *     the case that matters is a user who was tricked into buying one and
 *     holds a real balance. Refusing shows them nothing, and nothing
 *     reads as safe.
 */
describe('TokenIdentityService — lookalike identities', () => {
  interface CreatedRow {
    symbol: string;
    name: string;
    lookalikeOf: string | null;
    isScamProbability: number;
  }

  function setupCreating(scamScore: number): {
    service: TokenIdentityService;
    created: CreatedRow[];
  } {
    const created: CreatedRow[] = [];
    Container.set(TokenTypeRepository, {
      findByCode: async (code: string) => ({ id: `${code}-type-id`, code }) as never,
      findById: async (id: string) => ({ id, code: 'crypto' }) as never,
      findByCodes: async () => [] as never,
    } as unknown as TokenTypeRepository);
    Container.set(TokenRepository, {
      findByEvmContract: async () => null,
      findByIdentityTuple: async () => null,
      findBySymbolAndType: async () => null,
      findBySymbol: async () => null,
      create: async (row: CreatedRow) => {
        created.push(row);
        return { id: 'new-token', ...row } as never;
      },
    } as unknown as TokenRepository);
    Container.set(ScamTokenDetectionService, {
      calculateScamProbability: () => scamScore,
    } as unknown as ScamTokenDetectionService);
    const service = new TokenIdentityService();
    Container.set(TokenIdentityService, service);
    return { service, created };
  }

  test('a lookalike symbol is CREATED and stamped with what it impersonates', async () => {
    const { service, created } = setupCreating(0);
    await service.findOrCreateByIdentity({
      symbol: 'UЅDС',
      name: 'USD Coin',
      typeId: 'crypto-type-id',
    });
    expect(created).toHaveLength(1);
    expect(created[0]!.lookalikeOf).toBe('USDC');
  });

  /**
   * The reason `lookalike_of` is its own column. A homoglyph scores 1.00
   * while we hold no price for it and 0.70 once we do — the 0.25 is
   * "no pricing data available", a fact about our coverage that the
   * token has no part in, and `WarmTokenPricesForImportUseCase` re-scores
   * priced tokens downward. At 0.70 the score admits the row; the
   * characters still say what they say.
   */
  test('the mark does not depend on the scam score that pricing moves', async () => {
    const { service, created } = setupCreating(0.7);
    await service.findOrCreateByIdentity({
      symbol: 'UЅDС',
      name: 'USD Coin',
      typeId: 'crypto-type-id',
    });
    expect(created).toHaveLength(1);
    expect(created[0]!.isScamProbability).toBe(0.7);
    expect(created[0]!.lookalikeOf).toBe('USDC');
  });

  test('an ordinary token is created with no mark', async () => {
    const { service, created } = setupCreating(0);
    await service.findOrCreateByIdentity({
      symbol: 'USDC',
      name: 'USD Coin',
      typeId: 'crypto-type-id',
    });
    expect(created).toHaveLength(1);
    expect(created[0]!.lookalikeOf).toBeNull();
  });

  test('a name that is an instruction is REFUSED, even at a harmless score', async () => {
    const { service, created } = setupCreating(0);
    await expect(
      service.findOrCreateByIdentity({
        symbol: 'VOUCHER',
        name: '✅ SWAP YOUR VOUCHER ON T.LY/SHIBASWAP',
        typeId: 'crypto-type-id',
      })
    ).rejects.toThrow(ScamTokenRejectedError);
    expect(created).toHaveLength(0);
  });

  test('the score gate still refuses on its own at 0.95', async () => {
    const { service, created } = setupCreating(0.99);
    await expect(
      service.findOrCreateByIdentity({
        symbol: 'ANYTHING',
        name: 'Anything',
        typeId: 'crypto-type-id',
      })
    ).rejects.toThrow(ScamTokenRejectedError);
    expect(created).toHaveLength(0);
  });
});

/**
 * The guard, at the boundary rather than at the view (SC-276).
 *
 * `findOrCreateByIdentity` is where every provider's token identity is
 * normalised — balance imports reach it through
 * `TokenService.findOrCreateTokenFromIntegration`, transaction imports through
 * `TransactionRouter` — so decoding here covers both without either knowing
 * about it, and without an IBKR special case.
 *
 * These assert on what the repository is ASKED for, which is what gets stored.
 * A test that decoded in the assertion would pass against the old code.
 */
describe('TokenIdentityService — provider entities are decoded before storage', () => {
  function created(): { service: TokenIdentityService; names: (string | undefined)[] } {
    const names: (string | undefined)[] = [];
    Container.set(TokenTypeRepository, {
      findByCode: async (code: string) => ({ id: `${code}-type-id`, code }) as never,
    } as unknown as TokenTypeRepository);
    Container.set(TokenRepository, {
      findByEvmContract: async () => null,
      findByIdentityTuple: async (symbol: string) => {
        names.push(symbol);
        return { id: 'resolved', symbol } as never;
      },
    } as unknown as TokenRepository);
    Container.set(ScamTokenDetectionService, {} as unknown as ScamTokenDetectionService);
    const service = new TokenIdentityService();
    Container.set(TokenIdentityService, service);
    return { service, names };
  }

  test('the symbol reaches the lookup decoded and uppercased', async () => {
    const { service, names } = created();
    await service.findOrCreateByIdentity({
      symbol: 's&amp;p',
      name: 'VANGUARD S&amp;P 500 ETF',
      typeId: 'stock-type-id',
    });
    // Decoded first, THEN uppercased — the other order works here but would
    // not for an entity whose decoded form is case-sensitive.
    expect(names[0]).toBe('S&P');
  });

  test('a bare ampersand in a real name survives', async () => {
    const { service, names } = created();
    await service.findOrCreateByIdentity({
      symbol: 'at&t',
      name: 'AT&T INC',
      typeId: 'stock-type-id',
    });
    expect(names[0]).toBe('AT&T');
  });
});
