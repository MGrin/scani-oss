import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Token } from '@scani/db/schema';
import type {
  CurrentPriceProvider,
  HistoricalPriceProvider,
} from '@scani/providers/core/capabilities';
import type { ProviderContext } from '@scani/providers/core/types';
import { TRPCError } from '@trpc/server';
import { pricingRouter } from '../../../src/presentation/routers/pricing';
import {
  buildAuthedContext,
  buildUnauthedContext,
  installFreshRegistry,
} from '../../helpers/test-context';

const fakeToken: Token = {
  id: 'tok-eth',
  symbol: 'ETH',
  name: 'Ethereum',
  typeId: 'crypto',
  decimals: 18,
  iconUrl: null,
  providerMetadata: {},
  isScamProbability: 0,
  isActive: true,
  marketSegment: null,
  createdAt: new Date('2024-01-01T00:00:00Z'),
  updatedAt: new Date('2024-01-01T00:00:00Z'),
};

const fakeBase: Token = {
  ...fakeToken,
  id: 'tok-usd',
  symbol: 'USD',
  name: 'US Dollar',
  typeId: 'fiat',
  decimals: 2,
};

const okQuote = {
  tokenId: fakeToken.id,
  baseTokenId: fakeBase.id,
  price: '2500.00',
  timestamp: new Date('2024-03-15T12:00:00Z'),
  source: 'fake-coingecko',
};

let restoreRegistry: () => void;
let registry: ReturnType<typeof installFreshRegistry>['registry'];

beforeEach(() => {
  const x = installFreshRegistry();
  registry = x.registry;
  restoreRegistry = x.restore;
});

afterEach(() => {
  restoreRegistry();
});

function makePricer(
  overrides: Partial<HistoricalPriceProvider> & { providerKey?: string } = {}
): HistoricalPriceProvider {
  return {
    providerKey: overrides.providerKey ?? 'fake-coingecko',
    capabilities: ['historical-price'],
    canPrice: () => true,
    fetchCurrentPrice: async () => okQuote,
    fetchHistoricalPrice: async () => okQuote,
    ...overrides,
  };
}

describe('pricingRouter — auth', () => {
  test('rejects when bearer is absent', async () => {
    const caller = pricingRouter.createCaller(buildUnauthedContext());
    await expect(
      caller.fetchCurrentPrice({
        providerKey: 'fake',
        token: fakeToken,
        baseCurrency: fakeBase,
      })
    ).rejects.toMatchObject({ name: 'TRPCError', code: 'UNAUTHORIZED' });
  });
});

describe('pricingRouter.fetchCurrentPrice', () => {
  test('returns the quote when the provider succeeds', async () => {
    registry.register(makePricer());
    const caller = pricingRouter.createCaller(buildAuthedContext());
    const out = await caller.fetchCurrentPrice({
      providerKey: 'fake-coingecko',
      token: fakeToken,
      baseCurrency: fakeBase,
    });
    expect(out?.price).toBe('2500.00');
    expect(out?.source).toBe('fake-coingecko');
  });

  test('errors when no provider matches the requested key', async () => {
    const caller = pricingRouter.createCaller(buildAuthedContext());
    await expect(
      caller.fetchCurrentPrice({
        providerKey: 'unknown',
        token: fakeToken,
        baseCurrency: fakeBase,
      })
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  test('wraps a thrown provider error in TRPCError', async () => {
    registry.register(
      makePricer({
        providerKey: 'flaky',
        fetchCurrentPrice: async () => {
          throw new Error('upstream 503');
        },
      })
    );
    const caller = pricingRouter.createCaller(buildAuthedContext());
    await expect(
      caller.fetchCurrentPrice({
        providerKey: 'flaky',
        token: fakeToken,
        baseCurrency: fakeBase,
      })
    ).rejects.toBeInstanceOf(TRPCError);
  });
});

describe('pricingRouter.fetchCurrentPrices', () => {
  test('uses provider.fetchCurrentPrices batch hint when present', async () => {
    let batchCalls = 0;
    registry.register(
      makePricer({
        fetchCurrentPrices: async (tokens) => {
          batchCalls++;
          return new Map(tokens.map((t) => [t.id, { ...okQuote, tokenId: t.id }]));
        },
      })
    );
    const caller = pricingRouter.createCaller(buildAuthedContext());
    const out = await caller.fetchCurrentPrices({
      providerKey: 'fake-coingecko',
      tokens: [fakeToken, { ...fakeToken, id: 'tok-btc' }],
      baseCurrency: fakeBase,
    });
    expect(batchCalls).toBe(1);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.tokenId).sort()).toEqual(['tok-btc', 'tok-eth']);
  });

  test('falls back to per-token loop when batch is not implemented', async () => {
    let calls = 0;
    registry.register(
      makePricer({
        fetchCurrentPrice: async (t) => {
          calls++;
          return { ...okQuote, tokenId: t.id };
        },
      })
    );
    const caller = pricingRouter.createCaller(buildAuthedContext());
    const out = await caller.fetchCurrentPrices({
      providerKey: 'fake-coingecko',
      tokens: [fakeToken, { ...fakeToken, id: 'tok-btc' }],
      baseCurrency: fakeBase,
    });
    expect(calls).toBe(2);
    expect(out).toHaveLength(2);
  });

  test('skips tokens whose individual fetch throws (continue-on-error)', async () => {
    registry.register(
      makePricer({
        fetchCurrentPrice: async (t) => {
          if (t.id === 'bad') throw new Error('bad token');
          return { ...okQuote, tokenId: t.id };
        },
      })
    );
    const caller = pricingRouter.createCaller(buildAuthedContext());
    const out = await caller.fetchCurrentPrices({
      providerKey: 'fake-coingecko',
      tokens: [fakeToken, { ...fakeToken, id: 'bad' }],
      baseCurrency: fakeBase,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.tokenId).toBe('tok-eth');
  });
});

describe('pricingRouter.fetchHistoricalPrice', () => {
  test('returns the historical quote on success', async () => {
    registry.register(makePricer());
    const caller = pricingRouter.createCaller(buildAuthedContext());
    const out = await caller.fetchHistoricalPrice({
      providerKey: 'fake-coingecko',
      token: fakeToken,
      at: new Date('2024-03-15T00:00:00Z'),
      baseCurrency: fakeBase,
    });
    expect(out?.price).toBe('2500.00');
  });

  test('errors when no historical-pricer matches', async () => {
    const caller = pricingRouter.createCaller(buildAuthedContext());
    await expect(
      caller.fetchHistoricalPrice({
        providerKey: 'unknown',
        token: fakeToken,
        at: new Date(),
        baseCurrency: fakeBase,
      })
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });
});

describe('pricingRouter.fetchHistoricalRange', () => {
  test('returns a range when the provider supports it', async () => {
    registry.register(
      makePricer({
        fetchHistoricalRange: async () => [okQuote],
      })
    );
    const caller = pricingRouter.createCaller(buildAuthedContext());
    const out = await caller.fetchHistoricalRange({
      providerKey: 'fake-coingecko',
      token: fakeToken,
      from: new Date('2024-03-15T00:00:00Z'),
      to: new Date('2024-03-16T00:00:00Z'),
      baseCurrency: fakeBase,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.price).toBe('2500.00');
  });

  test('rejects when the provider lacks fetchHistoricalRange', async () => {
    registry.register(makePricer());
    const caller = pricingRouter.createCaller(buildAuthedContext());
    await expect(
      caller.fetchHistoricalRange({
        providerKey: 'fake-coingecko',
        token: fakeToken,
        from: new Date('2024-03-15T00:00:00Z'),
        to: new Date('2024-03-16T00:00:00Z'),
        baseCurrency: fakeBase,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('pricingRouter.convertRate', () => {
  test('returns 1 immediately for same-currency pair without hitting upstream', async () => {
    const caller = pricingRouter.createCaller(buildAuthedContext());
    const out = await caller.convertRate({ fromCurrency: 'USD', toCurrency: 'USD' });
    expect(out.rate).toBe('1');
  });
});

// Suppress type-check `unused` complaints when we don't use ProviderContext directly.
const _unused: ProviderContext | undefined = undefined;
void _unused;
const _unusedPricer: CurrentPriceProvider | undefined = undefined;
void _unusedPricer;
