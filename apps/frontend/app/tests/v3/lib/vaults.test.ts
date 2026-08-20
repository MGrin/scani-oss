import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import {
  attributedValue,
  compareVaultHoldings,
  compareVaults,
  isValidVaultPercentage,
  type VaultHoldingRow,
  type VaultRow,
  vaultIsMet,
  vaultProgress,
  vaultRemaining,
  vaultSaved,
} from '../../../src/v3/lib/vaults';

function vault(overrides: Partial<VaultRow> = {}): VaultRow {
  return {
    id: 'vault-1',
    name: 'House',
    currentAmount: '2500',
    targetAmount: '10000',
    progress: 25,
    color: '#22c55e',
    currencySymbol: '€',
    ...overrides,
  };
}

function holding(overrides: Partial<VaultHoldingRow> = {}): VaultHoldingRow {
  return {
    holdingId: 'h1',
    percentage: 50,
    tokenSymbol: 'BTC',
    accountName: 'Main',
    institutionName: 'Kraken',
    attributedValue: '500',
    holdingValue: '1000',
    ...overrides,
  };
}

describe('vaultProgress', () => {
  test('is the server number when it is inside the bar', () => {
    expect(vaultProgress(vault({ progress: 62.5 }))).toBe(62.5);
  });

  test('clamps at the ends, because a bar cannot draw past them', () => {
    expect(vaultProgress(vault({ progress: 140 }))).toBe(100);
    expect(vaultProgress(vault({ progress: -3 }))).toBe(0);
  });

  test('a missing progress is zero rather than NaN', () => {
    expect(vaultProgress(vault({ progress: null }))).toBe(0);
  });
});

describe('vaultIsMet', () => {
  test('reads the unclamped number, so an over-funded vault still counts', () => {
    expect(vaultIsMet(vault({ progress: 140 }))).toBe(true);
    expect(vaultIsMet(vault({ progress: 100 }))).toBe(true);
    expect(vaultIsMet(vault({ progress: 99.9 }))).toBe(false);
  });
});

describe('vaultRemaining', () => {
  test('is the gap to the target', () => {
    expect(vaultRemaining(vault())).toBe(7500);
  });

  test('floors at zero — "−€400 to go" is a figure nobody reads right', () => {
    expect(vaultRemaining(vault({ currentAmount: '12000' }))).toBe(0);
  });

  test('a null saved amount is zero saved, not a broken subtraction', () => {
    expect(vaultSaved(vault({ currentAmount: null }))).toBe(0);
    expect(vaultRemaining(vault({ currentAmount: null }))).toBe(10000);
  });
});

describe('compareVaults', () => {
  const ahead = vault({ id: 'ahead', currentAmount: '9000', progress: 90 });
  const behind = vault({ id: 'behind', name: 'Zeta', currentAmount: '10', progress: 1 });

  test('sorts by saved, progress, target and name', () => {
    expect(compareVaults(ahead, behind, 'saved', 'desc')).toBeLessThan(0);
    expect(compareVaults(ahead, behind, 'progress', 'desc')).toBeLessThan(0);
    expect(compareVaults(ahead, behind, 'name', 'asc')).toBeLessThan(0);
    expect(compareVaults(ahead, behind, 'target', 'asc')).toBe(0);
    expect(compareVaults(ahead, behind, 'unknown', 'asc')).toBe(0);
  });
});

describe('attributedValue', () => {
  test('prefers the vault’s share of the holding', () => {
    expect(attributedValue(holding())).toBe('500');
  });

  test('falls back to the whole position when no share has been computed', () => {
    expect(attributedValue(holding({ attributedValue: null }))).toBe('1000');
  });

  test('stays null when the token cannot be priced — never zero', () => {
    // Zero would silently understate the vault; "—" says the number is unknown.
    expect(attributedValue(holding({ attributedValue: null, holdingValue: null }))).toBeNull();
  });
});

describe('compareVaultHoldings', () => {
  test('largest contribution first', () => {
    const big = holding({ holdingId: 'big', attributedValue: '900' });
    const small = holding({ holdingId: 'small', attributedValue: '10' });
    expect(compareVaultHoldings(big, small)).toBeLessThan(0);
  });

  test('an unpriced holding sorts last rather than as zero', () => {
    const unpriced = holding({ holdingId: 'x', attributedValue: null, holdingValue: null });
    const priced = holding({ holdingId: 'y', attributedValue: '1' });
    expect(compareVaultHoldings(unpriced, priced)).toBeGreaterThan(0);
    expect(compareVaultHoldings(priced, unpriced)).toBeLessThan(0);
  });

  test('two unpriced holdings keep their order', () => {
    const a = holding({ holdingId: 'a', attributedValue: null, holdingValue: null });
    const b = holding({ holdingId: 'b', attributedValue: null, holdingValue: null });
    expect(compareVaultHoldings(a, b)).toBe(0);
  });
});

describe('isValidVaultPercentage', () => {
  test('matches what the mutation accepts', () => {
    expect(isValidVaultPercentage(0.5)).toBe(true);
    expect(isValidVaultPercentage(100)).toBe(true);
    expect(isValidVaultPercentage(0)).toBe(false);
    expect(isValidVaultPercentage(100.1)).toBe(false);
    expect(isValidVaultPercentage(Number.NaN)).toBe(false);
  });
});
