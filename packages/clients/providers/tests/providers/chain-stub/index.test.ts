import { describe, expect, test } from 'bun:test';
import type { ProviderContext, WithUserCreds } from '../../../src/core/types';
import { BitcoinProvider } from '../../../src/providers/bitcoin';
import { ChainStubProvider } from '../../../src/providers/chain-stub';
import { ETHERSCAN_CHAINS } from '../../../src/providers/etherscan/chains';
import { SolanaProvider } from '../../../src/providers/solana';
import { TonProvider } from '../../../src/providers/ton';
import { TronProvider } from '../../../src/providers/tron';

const GENESIS = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const UNKNOWN_BTC = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';

// The stub never touches these — an outflow limiter is only needed to
// construct the real providers, whose `isValidAddress` is pure.
const NEVER_CALLED = {
  execute: async () => {
    throw new Error('the address-shape comparison must not make a request');
  },
} as never;

function ctxFor(institutionCode: string, walletAddress?: string) {
  return {
    institutionCode,
    credentialsRef: 'stub',
    resolveCredentials: async () => (walletAddress ? { walletAddress } : {}),
  } as unknown as WithUserCreds<ProviderContext> & { institutionCode: string };
}

const stub = new ChainStubProvider();
const emptyCtx = {} as ProviderContext;

describe('ChainStubProvider', () => {
  test('claims every EVM chain in the Etherscan catalog plus the four non-EVM chains', () => {
    for (const chain of ETHERSCAN_CHAINS) {
      expect(stub.canValidate(chain.institutionCode)).toBe(true);
      expect(stub.canFetchBalances(chain.institutionCode)).toBe(true);
    }
    for (const code of ['bitcoin', 'solana', 'tron', 'ton']) {
      expect(stub.canValidate(code)).toBe(true);
      expect(stub.canFetchBalances(code)).toBe(true);
    }
    expect(stub.canValidate('kraken')).toBe(false);
    expect(stub.canFetchBalances('kraken')).toBe(false);
  });

  test('reports activity for a fixture wallet and nothing for an unknown one', async () => {
    expect(await stub.hasActivity(GENESIS, 'bitcoin', emptyCtx)).toBe(true);
    expect(await stub.hasActivity(UNKNOWN_BTC, 'bitcoin', emptyCtx)).toBe(false);
  });

  test('a base58 address valid on two chains is only active where the fixture says', async () => {
    // The genesis address is 34 base58 characters, so Solana's structural
    // check accepts it too. That is why the suite probed a public Solana
    // RPC on every wallet-import run, and why activity is a fixture rather
    // than "the address parses" (SC-490).
    expect(stub.isValidAddress(GENESIS, 'solana')).toBe(true);
    expect(await stub.hasActivity(GENESIS, 'solana', emptyCtx)).toBe(false);
  });

  test('fetchBalances returns the fixture native balance', async () => {
    const snapshots = await stub.fetchBalances(ctxFor('bitcoin', GENESIS));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.balance).toBe('50');
    expect(snapshots[0]?.externalId).toBe('native');
    expect(snapshots[0]?.tokenIdentity.symbol).toBe('BTC');
    expect(snapshots[0]?.tokenIdentity.decimals).toBe(8);
  });

  test('fetchBalances returns nothing for an address with no fixture', async () => {
    expect(await stub.fetchBalances(ctxFor('bitcoin', UNKNOWN_BTC))).toEqual([]);
    expect(await stub.fetchBalances(ctxFor('bitcoin'))).toEqual([]);
  });

  test('EVM chains report their own native token', async () => {
    // No fixture EVM wallet, so this asserts the catalog wiring rather
    // than a balance: an unknown address must produce no snapshot.
    expect(await stub.fetchBalances(ctxFor('ethereum', '0x'.padEnd(42, 'a')))).toEqual([]);
  });

  test('fetchTransactions is empty — no chain call escapes a stubbed boot', async () => {
    expect(await stub.fetchTransactions(ctxFor('bitcoin', GENESIS))).toEqual([]);
  });
});

describe('ChainStubProvider address shape matches the real providers', () => {
  const bitcoin = new BitcoinProvider(NEVER_CALLED);
  const solana = new SolanaProvider(NEVER_CALLED, 'https://example.invalid');
  const tron = new TronProvider(NEVER_CALLED, 'https://example.invalid', undefined);
  const ton = new TonProvider(NEVER_CALLED, 'https://example.invalid', undefined);

  const CORPUS = [
    GENESIS,
    UNKNOWN_BTC,
    '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
    'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
    '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
    '0xNOTHEX',
    'So11111111111111111111111111111111111111112',
    'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    'EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N',
    '',
    'not-an-address',
  ];

  test.each([
    ['bitcoin', (a: string) => bitcoin.isValidAddress(a)],
    ['solana', (a: string) => solana.isValidAddress(a)],
    ['tron', (a: string) => tron.isValidAddress(a)],
    ['ton', (a: string) => ton.isValidAddress(a)],
  ] as const)('%s agrees with the live provider on every corpus address', (code, live) => {
    for (const address of CORPUS) {
      expect([address, stub.isValidAddress(address, code)]).toEqual([address, live(address)]);
    }
  });

  test('every EVM code uses the 0x-address shape', () => {
    for (const address of CORPUS) {
      const expected = /^0x[a-fA-F0-9]{40}$/.test(address);
      for (const chain of ETHERSCAN_CHAINS) {
        expect([
          chain.institutionCode,
          address,
          stub.isValidAddress(address, chain.institutionCode),
        ]).toEqual([chain.institutionCode, address, expected]);
      }
    }
  });
});
