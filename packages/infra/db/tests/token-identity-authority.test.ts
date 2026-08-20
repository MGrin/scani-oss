/**
 * SC-403 — a token row that carries a NON-EVM native identity must not have
 * an EVM contract decide anything about it.
 *
 * The population that forced this: production BONK and TRUMP each held a
 * `solana.mint` (the token) beside a Base `etherscan.contractAddress` that is
 * a DIFFERENT token sharing the ticker — "Bonk by Virtuals" and "Trump Wars".
 * `symbol()` matches on both, so a symbol-equality guard catches neither.
 */
import { describe, expect, test } from 'bun:test';
import {
  foreignNativeChainKey,
  identityAuthority,
  identityDeltaConflict,
  mergeIdentityDeltas,
} from '../src/schema/token-identity-authority';

const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const BONK_IMPOSTOR = '0xf2b2c2a4e4eae02ba07decece8d831b11bd7a350';

describe('identityAuthority', () => {
  test('a row carrying a solana mint is foreign-native', () => {
    expect(identityAuthority({ solana: { mint: BONK_MINT } })).toBe('foreign-native');
  });

  test('a solana mint outranks an EVM contract on the same row', () => {
    expect(
      identityAuthority({
        solana: { mint: BONK_MINT },
        etherscan: { chainId: 8453, contractAddress: BONK_IMPOSTOR },
      })
    ).toBe('foreign-native');
  });

  test('a row with only an EVM contract is evm-contract', () => {
    expect(identityAuthority({ etherscan: { chainId: 1, contractAddress: '0xabc' } })).toBe(
      'evm-contract'
    );
  });

  test('an empty mint is not an identity', () => {
    expect(identityAuthority({ solana: { mint: '' } })).toBe('evm-contract');
  });

  test('null and undefined metadata do not throw', () => {
    expect(identityAuthority(null)).toBe('evm-contract');
    expect(identityAuthority(undefined)).toBe('evm-contract');
  });
});

describe('foreignNativeChainKey', () => {
  test('is the DeFiLlama solana key for a mint-bearing row', () => {
    expect(foreignNativeChainKey({ solana: { mint: BONK_MINT } })).toBe(`solana:${BONK_MINT}`);
  });

  test('is the mint even when an EVM contract sits beside it', () => {
    expect(
      foreignNativeChainKey({
        solana: { mint: BONK_MINT },
        defillama: { coin: `base:${BONK_IMPOSTOR}` },
        etherscan: { chainId: 8453, contractAddress: BONK_IMPOSTOR },
      })
    ).toBe(`solana:${BONK_MINT}`);
  });

  test('is null for a row with no foreign-native identity', () => {
    expect(
      foreignNativeChainKey({ etherscan: { chainId: 1, contractAddress: '0xabc' } })
    ).toBeNull();
  });
});

describe('identityDeltaConflict', () => {
  const nativeRow = { solana: { mint: BONK_MINT } };

  test('refuses an EVM contract attached to a foreign-native row', () => {
    expect(
      identityDeltaConflict(nativeRow, 'etherscan', {
        chainId: 8453,
        contractAddress: BONK_IMPOSTOR,
      })
    ).toContain('foreign-native');
  });

  test('refuses a defillama coin key that names a chain the row is not on', () => {
    expect(
      identityDeltaConflict(nativeRow, 'defillama', { coin: `base:${BONK_IMPOSTOR}` })
    ).toContain('foreign-native');
  });

  test('admits the defillama coin key that agrees with the mint', () => {
    expect(
      identityDeltaConflict(nativeRow, 'defillama', { coin: `solana:${BONK_MINT}` })
    ).toBeNull();
  });

  test('admits a native-EVM hint with no contract — absence is not contradiction', () => {
    expect(identityDeltaConflict(nativeRow, 'etherscan', { chainId: 8453 })).toBeNull();
  });

  test('admits an EVM contract on a row that has no foreign-native identity', () => {
    expect(
      identityDeltaConflict({}, 'etherscan', { chainId: 8453, contractAddress: BONK_IMPOSTOR })
    ).toBeNull();
  });

  test('admits namespaces that say nothing about chain identity', () => {
    expect(identityDeltaConflict(nativeRow, 'coingecko', { id: 'bonk' })).toBeNull();
    expect(identityDeltaConflict(nativeRow, 'finnhub', { symbol: 'BONK' })).toBeNull();
  });
});

describe('mergeIdentityDeltas', () => {
  test('adds namespaces the row does not have', () => {
    const result = mergeIdentityDeltas({}, [{ coingecko: { id: 'bonk' } }]);
    expect(result.merged).toEqual({ coingecko: { id: 'bonk' } });
    expect(result.changed).toBe(true);
    expect(result.refused).toEqual([]);
  });

  test('keeps the first writer of a namespace', () => {
    const result = mergeIdentityDeltas({ coingecko: { id: 'real' } }, [
      { coingecko: { id: 'impostor' } },
    ]);
    expect(result.merged).toEqual({ coingecko: { id: 'real' } });
    expect(result.changed).toBe(false);
  });

  test('refuses an EVM contract on a foreign-native row and says why', () => {
    const result = mergeIdentityDeltas({ solana: { mint: BONK_MINT } }, [
      { etherscan: { chainId: 8453, contractAddress: BONK_IMPOSTOR } },
    ]);
    expect(result.merged).toEqual({ solana: { mint: BONK_MINT } });
    expect(result.changed).toBe(false);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]).toContain(BONK_IMPOSTOR);
  });

  test('refuses a contract that a delta earlier in the same pass made foreign-native', () => {
    const result = mergeIdentityDeltas({}, [
      { solana: { mint: BONK_MINT } },
      { etherscan: { chainId: 8453, contractAddress: BONK_IMPOSTOR } },
    ]);
    expect(result.merged).toEqual({ solana: { mint: BONK_MINT } });
    expect(result.refused).toHaveLength(1);
  });

  test('refuses the EVM coin key that is the whole SC-403 defect', () => {
    const result = mergeIdentityDeltas(
      { solana: { mint: BONK_MINT }, etherscan: { chainId: 8453, contractAddress: BONK_IMPOSTOR } },
      [{ defillama: { coin: `base:${BONK_IMPOSTOR}` } }]
    );
    expect(result.merged.defillama).toBeUndefined();
    expect(result.refused).toHaveLength(1);
  });

  test('admits the coin key that agrees with the mint', () => {
    const result = mergeIdentityDeltas({ solana: { mint: BONK_MINT } }, [
      { defillama: { coin: `solana:${BONK_MINT}` } },
    ]);
    expect(result.merged.defillama).toEqual({ coin: `solana:${BONK_MINT}` });
    expect(result.changed).toBe(true);
  });

  test('null deltas are skipped, not merged', () => {
    const result = mergeIdentityDeltas({ solana: { mint: BONK_MINT } }, [null, null]);
    expect(result.changed).toBe(false);
    expect(result.refused).toEqual([]);
  });

  test('does not mutate the metadata it was handed', () => {
    const existing = { solana: { mint: BONK_MINT } };
    mergeIdentityDeltas(existing, [{ coingecko: { id: 'bonk' } }]);
    expect(existing).toEqual({ solana: { mint: BONK_MINT } });
  });
});
