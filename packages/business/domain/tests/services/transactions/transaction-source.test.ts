import { describe, expect, test } from 'bun:test';
import {
  NON_EVM_WALLET_SOURCES,
  sourceForChainId,
  sourceForProvider,
} from '../../../src/services/transactions/transaction-source';

describe('sourceForProvider', () => {
  test('maps CEX/broker names case-insensitively', () => {
    expect(sourceForProvider('Kraken')).toBe('kraken-api');
    expect(sourceForProvider('Interactive Brokers')).toBe('ibkr-api');
    expect(sourceForProvider('AIRWALLEX')).toBe('airwallex-api');
  });

  test('returns null for a blockchain — chains resolve by chain id, not name', () => {
    expect(sourceForProvider('Ethereum')).toBeNull();
    expect(sourceForProvider('Solana')).toBeNull();
  });
});

// One map, three callers: the wallet-import chain, the recurring
// transaction sync, and scripts/reimport-wallet-transactions.ts. The
// copies these replaced disagreed, and the disagreement was SC-360.
describe('sourceForChainId', () => {
  test('every EVM chain shares the etherscan source', () => {
    for (const chainId of [1, 56, 137, 43114, 42161, 10, 8453, 324, 59144, 1285]) {
      expect(sourceForChainId(chainId)).toBe('etherscan');
    }
  });

  test('accepts a chain id as a string — metadata stores it either way', () => {
    expect(sourceForChainId('1')).toBe('etherscan');
    expect(sourceForChainId('8453')).toBe('etherscan');
    expect(sourceForChainId('-2')).toBe('solana');
  });

  test('every non-EVM chain resolves from its sentinel', () => {
    expect(sourceForChainId(-2)).toBe('solana');
    // Bitcoin predates the negative-sentinel convention and uses 0, which
    // has to survive every falsy check on the way here (SC-364).
    expect(sourceForChainId(0)).toBe('bitcoin');
    expect(sourceForChainId('0')).toBe('bitcoin');
    expect(sourceForChainId(-1)).toBe('tron');
    expect(sourceForChainId(-15)).toBe('ton');
  });

  test('an unknown chain returns null rather than a guess', () => {
    expect(sourceForChainId(999999)).toBeNull();
    expect(sourceForChainId(-999)).toBeNull();
  });

  test('absent or unparseable chain id is null, never a default chain', () => {
    expect(sourceForChainId(null)).toBeNull();
    expect(sourceForChainId(undefined)).toBeNull();
    expect(sourceForChainId('')).toBeNull();
    expect(sourceForChainId('not-a-chain')).toBeNull();
  });
});

// The set the coordinator dispatches off. Its contents are asserted
// against `resolveInstitutionCode` in the coordinator's own suite —
// that pairing is the SC-364 guard.
describe('NON_EVM_WALLET_SOURCES', () => {
  test('holds every source the non-EVM sentinels resolve to', () => {
    for (const chainId of [0, -1, -2, -15]) {
      const source = sourceForChainId(chainId);
      expect(source).not.toBeNull();
      expect(NON_EVM_WALLET_SOURCES.has(source as string)).toBe(true);
    }
  });

  test('excludes etherscan, which routes by chain id instead', () => {
    expect(NON_EVM_WALLET_SOURCES.has('etherscan')).toBe(false);
  });
});
