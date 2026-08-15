import { describe, expect, test } from 'bun:test';
import type { FilterDef } from '@scani/ui/v3/hooks/useDataView';
import {
  countLabel,
  describeFilteredEmpty,
  nameList,
  resolveActiveFilters,
} from '@scani/ui/v3/lib/data-view';

const FILTER_DEFS: FilterDef[] = [
  {
    key: 'type',
    label: 'Type',
    options: [
      { value: 'crypto', label: 'Crypto' },
      { value: 'equity', label: 'Equity' },
    ],
  },
  {
    key: 'institution',
    label: 'Institution',
    options: [{ value: 'kr', label: 'Kraken' }],
  },
];

describe('resolveActiveFilters', () => {
  test('resolves keys and values to the names a person reads', () => {
    expect(resolveActiveFilters({ type: 'crypto' }, FILTER_DEFS)).toEqual([
      { key: 'type', label: 'Type', value: 'Crypto' },
    ]);
  });

  test('drops empty values', () => {
    expect(resolveActiveFilters({ type: '', institution: 'kr' }, FILTER_DEFS)).toEqual([
      { key: 'institution', label: 'Institution', value: 'Kraken' },
    ]);
  });

  // Object-key order is insertion order, so chips would reorder themselves as
  // the user set and cleared filters. The surface's declared order is stable.
  test('orders by the surface’s filter order, not by when the filter was set', () => {
    const resolved = resolveActiveFilters({ institution: 'kr', type: 'equity' }, FILTER_DEFS);
    expect(resolved.map((f) => f.key)).toEqual(['type', 'institution']);
  });

  test('falls back to the raw value when the option no longer exists', () => {
    expect(resolveActiveFilters({ type: 'bond' }, FILTER_DEFS)).toEqual([
      { key: 'type', label: 'Type', value: 'bond' },
    ]);
  });

  // A filter persisted under a key the surface has since dropped still has to
  // be listed, or it narrows the list to nothing with no chip to remove.
  test('keeps a filter whose def has gone, so it stays removable', () => {
    expect(resolveActiveFilters({ vault: 'v1' }, FILTER_DEFS)).toEqual([
      { key: 'vault', label: 'vault', value: 'v1' },
    ]);
  });

  test('works with no defs at all', () => {
    expect(resolveActiveFilters({ type: 'crypto' }, undefined)).toEqual([
      { key: 'type', label: 'type', value: 'crypto' },
    ]);
  });
});

describe('describeFilteredEmpty', () => {
  test('names the search term that matched nothing', () => {
    expect(describeFilteredEmpty('holdings', 'sol', []).title).toBe('No holdings match “sol”');
  });

  test('says filters when there is no search term', () => {
    const copy = describeFilteredEmpty('payments', '', [
      { key: 'type', label: 'Type', value: 'Crypto' },
    ]);
    expect(copy.title).toBe('No payments match those filters');
  });

  test('lists the active filters so the user knows what to undo', () => {
    const copy = describeFilteredEmpty('holdings', 'sol', [
      { key: 'type', label: 'Type', value: 'Crypto' },
      { key: 'institution', label: 'Institution', value: 'Kraken' },
    ]);
    expect(copy.title).toBe('No holdings match “sol”');
    expect(copy.description).toBe('Filtered by Type: Crypto, Institution: Kraken.');
  });

  test('has no description when only the search term is narrowing', () => {
    expect(describeFilteredEmpty('holdings', 'sol', []).description).toBeUndefined();
  });

  // Straight quotes read as code inside a sentence set in a sans face.
  test('uses typographic quotes', () => {
    const title = describeFilteredEmpty('holdings', 'sol', []).title;
    expect(title).not.toInclude('"');
  });
});

describe('countLabel', () => {
  test('pluralises by suffix', () => {
    expect(countLabel(12, 'holdings')).toBe('12 holdings');
    expect(countLabel(1, 'holdings')).toBe('1 holding');
    expect(countLabel(0, 'holdings')).toBe('0 holdings');
  });

  test('takes an explicit singular when dropping the s is wrong', () => {
    expect(countLabel(1, 'entries', 'entry')).toBe('1 entry');
  });
});

describe('nameList', () => {
  test('names a short selection so a confirmation can be checked against it', () => {
    expect(nameList(['BTC'])).toBe('BTC');
    expect(nameList(['BTC', 'ETH'])).toBe('BTC and ETH');
    expect(nameList(['BTC', 'ETH', 'SOL'])).toBe('BTC, ETH and SOL');
  });

  test('folds the tail rather than wrapping a sentence over the buttons', () => {
    expect(nameList(['BTC', 'ETH', 'SOL', 'AAPL', 'VWRA'])).toBe('BTC, ETH, SOL and 2 more');
  });

  test('is empty for an empty selection', () => {
    expect(nameList([])).toBe('');
  });
});
