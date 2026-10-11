import { describe, expect, test } from 'bun:test';
import {
  type BudgetAppMapping,
  defaultMapping,
  mappingBlockers,
  rowsLost,
  suggestCurrency,
  targetFrom,
  targetValue,
} from '@/v3/lib/budget-app-import';

describe('suggestCurrency (SC-1649)', () => {
  test('a bare dollar follows the person’s own dollar, else USD', () => {
    expect(suggestCurrency('$', 'CAD')).toBe('CAD');
    expect(suggestCurrency('$', 'EUR')).toBe('USD');
  });

  test('an unambiguous symbol names its currency', () => {
    expect(suggestCurrency('€', 'USD')).toBe('EUR');
    expect(suggestCurrency('C$', 'USD')).toBe('CAD');
  });

  test('no symbol, or one it does not know, offers the base currency', () => {
    expect(suggestCurrency(null, 'NZD')).toBe('NZD');
    expect(suggestCurrency('₿', 'GBP')).toBe('GBP');
  });
});

describe('budget app mapping (SC-1649)', () => {
  const mapping = (targets: BudgetAppMapping['target'][]): BudgetAppMapping[] =>
    targets.map((target, i) => ({ name: `A${i}`, rows: 1, target }));

  test('every account starts as a new one', () => {
    expect(defaultMapping([{ name: 'Checking', rows: [1, 2] }])).toEqual([
      { name: 'Checking', rows: 2, target: { kind: 'new', typeCode: 'checking' } },
    ]);
  });

  test('nothing blocks a mapping with an account and a currency code', () => {
    expect(
      mappingBlockers(mapping([{ kind: 'skip' }, { kind: 'new', typeCode: 'x' }]), 'usd')
    ).toEqual([]);
  });

  test('skipping every account, a code that is not one, and two accounts onto one all block', () => {
    expect(mappingBlockers(mapping([{ kind: 'skip' }]), 'US')).toEqual([
      'no-account',
      'no-currency',
    ]);
    expect(
      mappingBlockers(
        mapping([
          { kind: 'existing', accountId: 'a' },
          { kind: 'existing', accountId: 'a' },
        ]),
        'USD'
      )
    ).toEqual(['same-target']);
  });
});

describe('a target as one option value (SC-1649)', () => {
  test('every kind of target survives the round trip', () => {
    for (const target of [
      { kind: 'new', typeCode: 'savings' },
      { kind: 'existing', accountId: 'a-1' },
      { kind: 'skip' },
    ] as const) {
      expect(targetFrom(targetValue(target))).toEqual(target);
    }
  });
});

describe('rowsLost (SC-1649)', () => {
  test("counts the rows left out, but not a split's total line, whose parts are imported", () => {
    expect(
      rowsLost([{ reason: 'empty-row' }, { reason: 'split-parent' }, { reason: 'unreadable-date' }])
    ).toBe(2);
    expect(rowsLost([])).toBe(0);
  });
});
