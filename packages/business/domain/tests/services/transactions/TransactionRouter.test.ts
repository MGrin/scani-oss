process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterAll, describe, expect, test } from 'bun:test';
import type { Token } from '@scani/db/schema';
import type { TransactionsProvider } from '@scani/providers/core/capabilities';
import { ProviderRegistry } from '@scani/providers/core/registry';
import type { ProviderContext, TransactionEvent } from '@scani/providers/core/types';
import { Container } from 'typedi';
import { TokenTypeRepository } from '../../../src/repositories/EnumRepositories';
import { HoldingService } from '../../../src/services/holdings/HoldingService';
import { TokenIdentityService } from '../../../src/services/tokens/TokenIdentityService';
import {
  TransactionRouter,
  type TransactionRouterRequest,
} from '../../../src/services/transactions/TransactionRouter';

// Stubs leak across files because typedi's Container is process-global.
// After this suite, restore real @Service() instances so a later
// repo/service test that ran in the same `bun test` invocation can
// resolve the real DB-backed implementation.
afterAll(() => {
  Container.set(TokenTypeRepository, new TokenTypeRepository());
  Container.set(TokenIdentityService, new TokenIdentityService());
  Container.set(HoldingService, new HoldingService());
  Container.set(ProviderRegistry, new ProviderRegistry());
  Container.set(TransactionRouter, new TransactionRouter());
});

function makeBaseCurrency(): Token {
  return {
    id: 'usd-token',
    symbol: 'USD',
    name: 'US Dollar',
    typeId: 'fiat-type-id',
    decimals: 2,
    iconUrl: null,
    providerMetadata: {},
    isScamProbability: 0,
    isActive: true,
    marketSegment: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

interface SetupOpts {
  events: TransactionEvent[];
  /** When provided, the registry is seeded with a stub
      `TransactionsProvider` for this institutionCode. */
  withProviderForInstitution?: string;
}

function setup(opts: SetupOpts): {
  router: TransactionRouter;
  fetchCalls: number;
  request: TransactionRouterRequest;
} {
  let fetchCalls = 0;

  const provider: TransactionsProvider = {
    providerKey: 'stub',
    capabilities: ['transactions'],
    canFetchTransactions: (institutionCode: string) =>
      institutionCode === opts.withProviderForInstitution,
    fetchTransactions: async () => {
      fetchCalls++;
      return opts.events;
    },
  };

  const registry = new ProviderRegistry();
  if (opts.withProviderForInstitution) registry.register(provider);
  Container.set(ProviderRegistry, registry);

  // Stubs for TokenIdentityService, HoldingService, TokenTypeRepository.
  // They simulate "always finds/creates" with deterministic ids.
  Container.set(TokenIdentityService, {
    findOrCreateByIdentity: async (partial: { symbol?: string }) =>
      ({ id: `token-${partial.symbol ?? 'unknown'}` }) as never,
  } as unknown as TokenIdentityService);

  Container.set(HoldingService, {
    findOrCreateForIngest: async (input: {
      userId: string;
      accountId: string;
      tokenId: string;
    }): Promise<{ id: string }> => ({ id: `holding-${input.tokenId}` }),
  } as unknown as HoldingService);

  Container.set(TokenTypeRepository, {
    findByCode: async (code: string) =>
      code === 'crypto' ? ({ id: 'crypto-type-id' } as never) : ({ id: 'fiat-type-id' } as never),
  } as unknown as TokenTypeRepository);

  const router = new TransactionRouter();
  Container.set(TransactionRouter, router);

  const request: TransactionRouterRequest = {
    userId: 'u1',
    accountId: 'a1',
    institutionId: 'inst-1',
    institutionCode: 'kraken',
    source: 'kraken-api',
    baseCurrency: makeBaseCurrency(),
    resolveCredentials: (async () => ({
      apiKey: 'x',
      apiSecret: 'y',
    })) as ProviderContext['resolveCredentials'],
  };

  return {
    router,
    fetchCalls: 0,
    request,
    get fetchCallsCount() {
      return fetchCalls;
    },
  } as never;
}

describe('TransactionRouter.hasProviderFor', () => {
  test('returns false when no provider matches the institutionCode', () => {
    const { router } = setup({ events: [] });
    expect(router.hasProviderFor('kraken')).toBe(false);
  });

  test('returns true when the registry has a provider for the code', () => {
    const { router } = setup({ events: [], withProviderForInstitution: 'kraken' });
    expect(router.hasProviderFor('kraken')).toBe(true);
  });
});

describe('TransactionRouter.run', () => {
  test('throws when no provider is registered for the institutionCode', async () => {
    const { router, request } = setup({ events: [] });
    await expect(router.run(request)).rejects.toThrow(/no provider registered/);
  });

  test('returns an empty result when the provider returns no events', async () => {
    const { router, request } = setup({ events: [], withProviderForInstitution: 'kraken' });
    const result = await router.run(request);
    expect(result.transactions).toHaveLength(0);
    expect(result.observations).toHaveLength(0);
    expect(result.firstEventAt).toBeNull();
    expect(result.lastEventAt).toBeNull();
    // No `since` provided in request → claims complete history.
    expect(result.hasCompleteTxHistory).toBe(true);
  });

  test('reports incomplete history when called with a since cutoff', async () => {
    const { router, request } = setup({ events: [], withProviderForInstitution: 'kraken' });
    const result = await router.run({ ...request, since: new Date('2024-01-01') });
    expect(result.hasCompleteTxHistory).toBe(false);
  });

  test('materializes a single deposit event into a NewHoldingTransaction', async () => {
    const occurred = new Date('2024-06-01T10:00:00Z');
    const { router, request } = setup({
      withProviderForInstitution: 'kraken',
      events: [
        {
          externalId: 'deposit-1',
          occurredAt: occurred,
          kind: 'deposit',
          primary: { tokenIdentity: { symbol: 'BTC', name: 'Bitcoin' }, quantity: '0.5' },
        },
      ],
    });
    const result = await router.run(request);
    expect(result.transactions).toHaveLength(1);
    const tx = result.transactions[0];
    expect(tx?.kind).toBe('deposit');
    expect(tx?.quantity).toBe('0.5');
    expect(tx?.tokenId).toBe('token-BTC');
    expect(tx?.holdingId).toBe('holding-token-BTC');
    expect(tx?.source).toBe('kraken-api');
    expect(tx?.externalId).toBe('deposit-1');
    expect(tx?.occurredAt.getTime()).toBe(occurred.getTime());
    expect(result.firstEventAt?.getTime()).toBe(occurred.getTime());
    expect(result.lastEventAt?.getTime()).toBe(occurred.getTime());
  });

  test('tracks first/last event timestamps across multiple events', async () => {
    const t1 = new Date('2024-05-01T00:00:00Z');
    const t2 = new Date('2024-06-01T00:00:00Z');
    const t3 = new Date('2024-04-01T00:00:00Z');
    const { router, request } = setup({
      withProviderForInstitution: 'kraken',
      events: [
        {
          externalId: 'a',
          occurredAt: t1,
          kind: 'deposit',
          primary: { tokenIdentity: { symbol: 'ETH' }, quantity: '1' },
        },
        {
          externalId: 'b',
          occurredAt: t2,
          kind: 'deposit',
          primary: { tokenIdentity: { symbol: 'ETH' }, quantity: '2' },
        },
        {
          externalId: 'c',
          occurredAt: t3,
          kind: 'deposit',
          primary: { tokenIdentity: { symbol: 'ETH' }, quantity: '3' },
        },
      ],
    });
    const result = await router.run(request);
    expect(result.transactions).toHaveLength(3);
    // t3 is earliest, t2 latest.
    expect(result.firstEventAt?.getTime()).toBe(t3.getTime());
    expect(result.lastEventAt?.getTime()).toBe(t2.getTime());
  });
});
