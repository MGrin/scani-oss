import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AddressValidatorProvider, BalanceProvider } from '@scani/providers/core/capabilities';
import { chainsRouter } from '../../../src/presentation/routers/chains';
import {
  buildAuthedContext,
  buildUnauthedContext,
  installFreshRegistry,
} from '../../helpers/test-context';

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

function makeBalanceProvider(
  institutionCode: string,
  overrides: Partial<BalanceProvider> = {}
): BalanceProvider {
  return {
    providerKey: institutionCode,
    capabilities: ['balances'],
    canFetchBalances: (code) => code === institutionCode,
    fetchBalances: async () => [],
    ...overrides,
  } as BalanceProvider;
}

function makeAddressValidator(
  institutionCode: string,
  overrides: Partial<AddressValidatorProvider> = {}
): AddressValidatorProvider {
  return {
    providerKey: institutionCode,
    capabilities: ['address-validation'],
    canValidate: (code) => code === institutionCode,
    isValidAddress: () => true,
    hasActivity: async () => false,
    resolveAddressName: async () => null,
    ...overrides,
  } as AddressValidatorProvider;
}

describe('chainsRouter — auth', () => {
  test('rejects unauthed listConfigs', async () => {
    const caller = chainsRouter.createCaller(buildUnauthedContext());
    await expect(caller.listConfigs()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  test('rejects unauthed getTokenBalances', async () => {
    const caller = chainsRouter.createCaller(buildUnauthedContext());
    await expect(caller.getTokenBalances({ chainId: 1, address: '0xabc' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});

describe('chainsRouter.listConfigs', () => {
  test('returns the static chain catalog', async () => {
    const caller = chainsRouter.createCaller(buildAuthedContext());
    const out = await caller.listConfigs();
    expect(out.length).toBeGreaterThan(0);
    const eth = out.find((c) => c.chainId === 1);
    expect(eth?.type).toBe('evm');
    expect(eth?.nativeSymbol).toBe('ETH');
  });
});

describe('chainsRouter.getTokenBalances', () => {
  test('rejects unsupported chainId', async () => {
    const caller = chainsRouter.createCaller(buildAuthedContext());
    await expect(
      caller.getTokenBalances({ chainId: 99999, address: '0xabc' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  test('errors when no balance-provider is registered for the chain', async () => {
    const caller = chainsRouter.createCaller(buildAuthedContext());
    await expect(caller.getTokenBalances({ chainId: 1, address: '0xabc' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });

  test('projects HoldingSnapshot[] into TokenBalance[] on success', async () => {
    registry.register(
      makeBalanceProvider('ethereum', {
        fetchBalances: async () => [
          {
            externalId: 'native',
            balance: '1500000000000000000',
            tokenIdentity: {
              symbol: 'ETH',
              name: 'Ethereum',
              decimals: 18,
              typeId: 'crypto',
              providerMetadata: {},
              iconUrl: null,
              isScamProbability: 0,
              marketSegment: null,
            },
            // biome-ignore lint/suspicious/noExplicitAny: HoldingSnapshot has more fields; only what fetchBalances returns is read
          } as any,
          {
            externalId: 'usdc',
            balance: '5000000',
            tokenIdentity: {
              symbol: 'USDC',
              name: 'USD Coin',
              decimals: 6,
              typeId: 'crypto',
              providerMetadata: { etherscan: { contractAddress: '0xA0b8...' } },
              iconUrl: null,
              isScamProbability: 0,
              marketSegment: null,
            },
            // biome-ignore lint/suspicious/noExplicitAny: HoldingSnapshot has more fields; only what fetchBalances returns is read
          } as any,
        ],
      })
    );
    const caller = chainsRouter.createCaller(buildAuthedContext());
    const out = await caller.getTokenBalances({ chainId: 1, address: '0xabc' });
    expect(out).toHaveLength(2);
    expect(out[0]?.symbol).toBe('ETH');
    expect(out[0]?.isNative).toBe(true);
    expect(out[1]?.symbol).toBe('USDC');
    expect(out[1]?.isNative).toBe(false);
    expect(out[1]?.tokenAddress).toBe('0xA0b8...');
  });

  test('maps a thrown provider error to INTERNAL_SERVER_ERROR', async () => {
    registry.register(
      makeBalanceProvider('ethereum', {
        fetchBalances: async () => {
          throw new Error('rpc unreachable');
        },
      })
    );
    const caller = chainsRouter.createCaller(buildAuthedContext());
    await expect(caller.getTokenBalances({ chainId: 1, address: '0xabc' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });
});

describe('chainsRouter.resolveAddressName', () => {
  test('returns null for unsupported chainId (not an error)', async () => {
    const caller = chainsRouter.createCaller(buildAuthedContext());
    const out = await caller.resolveAddressName({ chainId: 99999, address: '0xabc' });
    expect(out).toBeNull();
  });

  test('returns null when validator returns null', async () => {
    registry.register(makeAddressValidator('ethereum'));
    const caller = chainsRouter.createCaller(buildAuthedContext());
    const out = await caller.resolveAddressName({ chainId: 1, address: '0xabc' });
    expect(out).toBeNull();
  });

  test('returns the resolved name on success', async () => {
    const validator = makeAddressValidator('ethereum', {
      resolveAddressName: async () => 'vitalik.eth',
    });
    registry.register(validator);
    // Sanity: registry has the validator.
    expect(registry.getAddressValidator('ethereum')).toBe(validator);
    const caller = chainsRouter.createCaller(buildAuthedContext());
    const out = await caller.resolveAddressName({ chainId: 1, address: '0xabc' });
    expect(out).toBe('vitalik.eth');
  });

  test('swallows validator throws and returns null', async () => {
    registry.register(
      makeAddressValidator('ethereum', {
        resolveAddressName: async () => {
          throw new Error('boom');
        },
      })
    );
    const caller = chainsRouter.createCaller(buildAuthedContext());
    const out = await caller.resolveAddressName({ chainId: 1, address: '0xabc' });
    expect(out).toBeNull();
  });
});
