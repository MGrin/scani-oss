import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import type { HoldingWithDetails } from '@scani/shared';
import i18n from 'i18next';
import { holdingsDataViewConfig } from '../../../src/v3/components/holdings/holdingsConfig';
import {
  DATA_QUALITY_KINDS,
  dataQualityOptions,
  HOLDINGS_QUALITY_PARAM,
  type qualityFilterFn,
} from '../../../src/v3/lib/dataQuality';
import { HOLDING_FILTER_PARAMS } from '../../../src/v3/lib/holdings';
import { holdingsQualityPath } from '../../../src/v3/lib/routes';

/**
 * The data-quality dimension of the Holdings list (SC-293) — the destination
 * the Settings panel's flagged rows link to.
 *
 * The property under test throughout is **the count is the list**. The panel
 * shows `flagged[kind].length` and the link opens the list narrowed to
 * `flagged[kind]`, so the figure a reader taps and the number of rows they
 * land on are the same array read twice. That only holds while the filter
 * stays an id-set lookup: the moment anyone re-derives "zero balance" from
 * `item.amount` here, the two can drift, and a panel that says 12 over a list
 * of 11 is the defect SC-268 was already once burned by.
 */

const t = i18n.t.bind(i18n);

function holding(id: string, overrides: Partial<HoldingWithDetails> = {}): HoldingWithDetails {
  return {
    id,
    token: {
      id: `token-${id}`,
      symbol: 'USDC',
      name: 'USD Coin',
      type: 'Crypto',
      typeCode: 'crypto',
      isScamProbability: 0,
      lookalikeOf: null,
    },
    amount: '1000',
    value: 1000,
    costBasis: 1000,
    account: {
      id: 'a1',
      name: 'Spot',
      type: 'Exchange',
      typeCode: 'exchange',
      institutionId: 'i1',
    },
    institution: { id: 'i1', name: 'Kraken', type: 'Exchange', typeCode: 'exchange' },
    groups: [],
    lastUpdated: '2026-08-12T09:00:00.000Z',
    createdAt: '2026-03-03T09:00:00.000Z',
    isActive: true,
    isHidden: false,
    source: 'import_wallet',
    ...overrides,
  };
}

function configFor(
  holdings: HoldingWithDetails[],
  qualitySets: Parameters<typeof qualityFilterFn>[0]
) {
  return holdingsDataViewConfig({
    holdings,
    t,
    currency: '$',
    institutions: undefined,
    accounts: undefined,
    groups: undefined,
    onBulkDelete: () => undefined,
    defaultFilters: {},
    qualitySets,
    onAssignGroups: () => undefined,
    onAddData: () => undefined,
    peek: {
      t,
      currency: '$',
      onSetAmount: () => undefined,
      onToggleActive: () => undefined,
      onRefreshPrice: () => undefined,
      onRefreshBalance: () => undefined,
      refreshingPriceId: null,
      refreshingBalanceId: null,
      onEditPrice: () => undefined,
      onConfigureApy: () => undefined,
      onRemoveApy: () => undefined,
      onDelete: () => undefined,
    },
  });
}

function qualityDef(qualitySets: Parameters<typeof qualityFilterFn>[0]) {
  const def = configFor([], qualitySets).filterDefs?.find(
    (entry) => entry.key === HOLDINGS_QUALITY_PARAM
  );
  if (!def) throw new Error('the holdings list declares no data-quality filter');
  return def;
}

describe('the holdings list can be narrowed by data quality', () => {
  test('the filter key is a holdings query parameter', () => {
    // Without this the panel's `?quality=noCoverage` is a parameter nothing
    // reads, and the link lands on an unfiltered list of everything —
    // strictly worse than the inert row it replaced.
    expect(HOLDING_FILTER_PARAMS).toContain(HOLDINGS_QUALITY_PARAM);
  });

  test('a panel link names a kind the filter understands', () => {
    for (const kind of DATA_QUALITY_KINDS) {
      expect(holdingsQualityPath(kind)).toBe(`/holdings?${HOLDINGS_QUALITY_PARAM}=${kind}`);
      expect(qualityDef({ [kind]: ['h1'] }).options.map((o) => o.value)).toContain(kind);
    }
  });

  test('the filter selects exactly the ids the server named', () => {
    const holdings = [holding('h1'), holding('h2'), holding('h3')];
    const def = qualityDef({ noCoverage: ['h1', 'h3'] });
    const selected = holdings.filter((item) => def.fn?.(item, 'noCoverage'));
    expect(selected.map((item) => item.id)).toEqual(['h1', 'h3']);
  });

  test('the count on the panel is the length of the list it opens', () => {
    // The property the whole ticket rests on, asserted rather than assumed:
    // the row shows `ids.length` and the list shows the rows whose id is in
    // `ids`, so a divergence here is a divergence a reader would see.
    const ids = ['h2', 'h4', 'h5'];
    const holdings = ['h1', 'h2', 'h3', 'h4', 'h5'].map((id) => holding(id));
    const def = qualityDef({ negativeOpening: ids });
    expect(holdings.filter((item) => def.fn?.(item, 'negativeOpening')).length).toBe(ids.length);
  });

  test('it does not re-derive the rule from the row', () => {
    // A zero-balance holding the server did NOT name stays out, and a
    // thousand-unit one it DID name stays in. Either assertion failing means
    // somebody replaced the id lookup with a local predicate, and the panel's
    // number and this list are now two answers to one question.
    const notNamed = holding('h1', { amount: '0' });
    const named = holding('h2', { amount: '1000' });
    const def = qualityDef({ zeroBalance: ['h2'] });
    expect(def.fn?.(notNamed, 'zeroBalance')).toBe(false);
    expect(def.fn?.(named, 'zeroBalance')).toBe(true);
  });

  test('an unknown kind selects nothing rather than everything', () => {
    // A stale bookmark, or a hand-typed parameter. `filters` that match no
    // option still reach `fn`, and a predicate that fell through to `true`
    // would render the whole list under a chip claiming a slice of it.
    const def = qualityDef({ noCoverage: ['h1'] });
    expect(def.fn?.(holding('h1'), 'notAKind')).toBe(false);
  });

  test('Refine offers only the kinds this reader has', () => {
    // A control that selects nothing answers a question the reader never
    // asked, and it would disagree with the panel, which lists exactly the
    // kinds they do have.
    expect(dataQualityOptions({ noCoverage: ['h1'], zeroBalance: [] }).map((o) => o.value)).toEqual(
      ['noCoverage']
    );
    expect(dataQualityOptions(undefined)).toEqual([]);
    expect(qualityDef(undefined).options).toEqual([]);
  });

  test('every kind has copy behind it', () => {
    // `UiTranslationKey` is `ui.${string}` — a typo type-checks and renders
    // the key. i18next resolves an unknown key to itself, so the test is that
    // the resolved string is not the key.
    for (const option of qualityDef(Object.fromEntries(DATA_QUALITY_KINDS.map((k) => [k, ['h1']])))
      .options) {
      const key = 'labelKey' in option ? (option.labelKey as string) : '';
      expect(key).not.toBe('');
      expect(i18n.t(key)).not.toBe(key);
    }
    expect(i18n.t('ui.dataView.holdings.filter.quality')).toBe('Data quality');
  });
});
