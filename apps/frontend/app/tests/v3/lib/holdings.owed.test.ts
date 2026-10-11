import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { balanceFromEditor, holdingOwes, seedForEditor } from '../../../src/v3/lib/holdings';

// SC-1640. What a loan or card owes is stored negative and typed positive.
const owed = { account: { class: 'liability' as const }, token: { typeCode: 'fiat' } };
const asset = { account: { class: 'asset' as const }, token: { typeCode: 'fiat' } };
const cryptoOnCard = { account: { class: 'liability' as const }, token: { typeCode: 'crypto' } };

describe('holdingOwes', () => {
  test('only fiat on a liability account owes', () => {
    expect(holdingOwes(owed)).toBe(true);
    expect(holdingOwes(asset)).toBe(false);
    expect(holdingOwes(cryptoOnCard)).toBe(false);
  });
});

describe('the edit sheet round trip', () => {
  test('a loan shows positive and saves negative', () => {
    expect(seedForEditor(owed, '-480000.50')).toBe('480000.50');
    expect(balanceFromEditor(owed, '479000')).toBe('-479000');
  });

  // An untouched sheet must send nothing: the round trip returns the seed's
  // exact string, trailing zeros and all (SC-567's no-keystroke-no-write).
  test('an untouched owed figure round-trips to the stored string', () => {
    for (const stored of ['-480000.50', '-0.10', '0']) {
      expect(balanceFromEditor(owed, seedForEditor(owed, stored))).toBe(stored);
    }
  });

  test('an asset passes through unchanged, and an empty draft stays empty', () => {
    expect(seedForEditor(asset, '12.5')).toBe('12.5');
    expect(balanceFromEditor(asset, '13')).toBe('13');
    expect(balanceFromEditor(owed, '  ')).toBe('');
  });
});
