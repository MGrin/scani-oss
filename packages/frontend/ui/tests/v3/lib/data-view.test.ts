import { describe, expect, test } from 'bun:test';
import { addUiLocale, uiT } from '@scani/ui/i18n';
import type { V3FilterDef } from '@scani/ui/v3/lib/data-view';
import {
  countLabel,
  describeFilteredEmpty,
  nameList,
  resolveActiveFilters,
  resolveDataViewSurface,
} from '@scani/ui/v3/lib/data-view';

/**
 * A host registering its list nouns, which is exactly what
 * `apps/frontend/app/src/i18n` and `apps/frontend/cloud/src/main.tsx` do
 * (SC-257). The assertions below are UNCHANGED from when these helpers took
 * an English word — that is the point: the English is the same, and it now
 * comes from a key a translator can reach.
 *
 * `entries` is here because it is the case `nounSingular` existed for: the
 * singular is not the plural minus an `s`. i18next needs no escape hatch —
 * `_one` simply says what the word is.
 */
addUiLocale('en', {
  ui: {
    dataView: {
      noun: {
        holdings_one: 'holding',
        holdings_other: 'holdings',
        holdings_counted_one: '{{count}} holding',
        holdings_counted_other: '{{count}} holdings',
        payments_one: 'payment',
        payments_other: 'payments',
        payments_counted_one: '{{count}} payment',
        payments_counted_other: '{{count}} payments',
        entries_one: 'entry',
        entries_other: 'entries',
        entries_counted_one: '{{count}} entry',
        entries_counted_other: '{{count}} entries',
      },
      // The fixtures' own filter labels — a host registering its copy, which is
      // what every list surface does at boot (SC-262).
      test: {
        account: 'Account',
        all69Holdings: 'All 69 holdings',
        connectAnExchangeAndYour: 'Connect an exchange and your positions appear here.',
        everythingWeHave: 'Everything we have',
        group: 'Group',
        holding: 'Holding',
        institution: 'Institution',
        noHoldingsYet: 'No holdings yet',
        none: 'None',
        symbol: 'Symbol',
        these12Holdings: 'These 12 holdings',
        this1mWindow: 'This 1M window',
        this1wWindow: 'This 1W window',
        this3mWindow: 'This 3M window',
        type: 'Type',
        value: 'Value',
        vault: 'vault',
      },
    },
  },
});

const HOLDINGS = 'ui.dataView.noun.holdings';
const PAYMENTS = 'ui.dataView.noun.payments';
const ENTRIES = 'ui.dataView.noun.entries';

const FILTER_DEFS: V3FilterDef[] = [
  {
    key: 'type',
    labelKey: 'ui.dataView.test.type',
    options: [
      { value: 'crypto', label: 'Crypto' },
      { value: 'equity', label: 'Equity' },
    ],
  },
  {
    key: 'institution',
    labelKey: 'ui.dataView.test.institution',
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
      // No def, so there is no key to name it with: the raw filter key stands
      // in, and i18next resolves an unknown key to itself. A stale persisted
      // filter stays removable rather than rendering blank.
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
    expect(describeFilteredEmpty(HOLDINGS, 'sol', []).title).toBe('No holdings match “sol”');
  });

  test('says filters when there is no search term', () => {
    const copy = describeFilteredEmpty(PAYMENTS, '', [
      { key: 'type', label: 'Type', value: 'Crypto' },
    ]);
    expect(copy.title).toBe('No payments match those filters');
  });

  test('lists the active filters so the user knows what to undo', () => {
    const copy = describeFilteredEmpty(HOLDINGS, 'sol', [
      { key: 'type', label: 'Type', value: 'Crypto' },
      { key: 'institution', label: 'Institution', value: 'Kraken' },
    ]);
    expect(copy.title).toBe('No holdings match “sol”');
    expect(copy.description).toBe('Filtered by Type: Crypto, Institution: Kraken.');
  });

  test('has no description when only the search term is narrowing', () => {
    expect(describeFilteredEmpty(HOLDINGS, 'sol', []).description).toBeUndefined();
  });

  // Straight quotes read as code inside a sentence set in a sans face.
  test('uses typographic quotes', () => {
    const title = describeFilteredEmpty(HOLDINGS, 'sol', []).title;
    expect(title).not.toInclude('"');
  });

  /** SC-244: the same call, with and without the fact that it narrowed a page. */
  test('a narrowing that only saw a page says so instead of answering for the set', () => {
    const copy = describeFilteredEmpty(HOLDINGS, 'sol', [], 25);
    expect(copy.title).toBe('No matches in what is loaded');
    expect(copy.description).toBe(
      'Search and filters only see the 25 holdings loaded so far. Load more to widen them.'
    );
  });

  test('a page narrowing still lists what is applied', () => {
    const copy = describeFilteredEmpty(
      HOLDINGS,
      '',
      [{ key: 'type', label: 'Type', value: 'Crypto' }],
      25
    );
    expect(copy.description).toInclude('loaded so far');
    expect(copy.description).toInclude('Filtered by Type: Crypto.');
  });
});

/**
 * SC-244. The two "nothing here" screens were one boolean apart and the wrong
 * one was reachable; these are the cases that separate them.
 */
describe('resolveDataViewSurface', () => {
  const base = {
    isLoading: false,
    isError: false,
    totalCount: 25,
    filteredCount: 0,
    partial: false,
    searchTerm: '',
    searchIsRemote: false,
    activeFilterCount: 1,
  };

  test('rows win whenever anything survived the narrowing', () => {
    expect(resolveDataViewSurface({ ...base, filteredCount: 3 }).surface).toBe('rows');
  });

  test('a complete set narrowed to nothing answers for the set', () => {
    expect(resolveDataViewSurface(base).surface).toBe('no-match');
  });

  test('a page narrowed to nothing answers for the page', () => {
    expect(resolveDataViewSurface({ ...base, partial: true }).surface).toBe('no-match-loaded');
  });

  test('nothing at all is the onboarding screen, not a failed narrowing', () => {
    const state = resolveDataViewSurface({ ...base, totalCount: 0, activeFilterCount: 0 });
    expect(state.surface).toBe('empty');
    expect(state.hasNothingAtAll).toBe(true);
  });

  /**
   * The trap server-side search introduces. Page one of a search that matched
   * nothing IS an empty page, and reading that as an empty account renders
   * "No files yet — upload your first invoice" at someone holding four hundred.
   */
  test('a remote search that found nothing is not an empty account', () => {
    const state = resolveDataViewSurface({
      ...base,
      totalCount: 0,
      activeFilterCount: 0,
      searchTerm: 'revolut',
      searchIsRemote: true,
    });
    expect(state.surface).toBe('no-match');
    expect(state.hasNothingAtAll).toBe(false);
  });

  /** It read every row, so its answer is about every row — no "load more". */
  test('a remote search never asks the reader to widen it', () => {
    expect(
      resolveDataViewSurface({
        ...base,
        activeFilterCount: 0,
        partial: true,
        searchTerm: 'revolut',
        searchIsRemote: true,
      }).surface
    ).toBe('no-match');
  });

  test('a LOCAL search over a page does', () => {
    expect(
      resolveDataViewSurface({ ...base, activeFilterCount: 0, partial: true, searchTerm: 'sol' })
        .surface
    ).toBe('no-match-loaded');
  });

  test('an unsettled read is neither empty nor unmatched', () => {
    expect(resolveDataViewSurface({ ...base, isLoading: true, totalCount: 0 }).surface).toBe(
      'rows'
    );
  });

  test('a failed read takes the surface only when there is nothing to keep', () => {
    expect(
      resolveDataViewSurface({ ...base, isError: true, totalCount: 0, activeFilterCount: 0 })
        .surface
    ).toBe('error');
    // Stale rows are still rows: the data is old, not gone.
    expect(resolveDataViewSurface({ ...base, isError: true, filteredCount: 3 }).surface).toBe(
      'rows'
    );
  });
});

describe('countLabel', () => {
  test('counts, in the form the number selects', () => {
    expect(countLabel(HOLDINGS, 12)).toBe('12 holdings');
    expect(countLabel(HOLDINGS, 1)).toBe('1 holding');
    expect(countLabel(HOLDINGS, 0)).toBe('0 holdings');
  });

  // The case `nounSingular` was invented for. It needs no escape hatch now:
  // the singular is not derived from the plural, it is simply declared.
  test('a word whose singular is not the plural minus an s', () => {
    expect(countLabel(ENTRIES, 1)).toBe('1 entry');
    expect(countLabel(ENTRIES, 4)).toBe('4 entries');
  });

  // The bare noun and the counted phrase come off ONE key, which is what
  // stops them drifting — and what a language with three plural forms needs.
  test('the same key gives the bare noun, without a number in it', () => {
    expect(uiT(HOLDINGS, { count: 1 })).toBe('holding');
    expect(uiT(HOLDINGS, { count: 2 })).toBe('holdings');
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
