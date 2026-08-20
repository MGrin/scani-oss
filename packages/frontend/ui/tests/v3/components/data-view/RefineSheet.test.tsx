import { describe, expect, test } from 'bun:test';
import { addUiLocale } from '@scani/ui/i18n';
import { Sheet } from '@scani/ui/ui/sheet';
import {
  RefineFooter,
  RefineHeader,
  RefineSections,
} from '@scani/ui/v3/components/data-view/RefineSheet';
import type { V3FilterDef, V3GroupByDef, V3SortDef } from '@scani/ui/v3/lib/data-view';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The fixtures' own labels, registered the way a host registers its own
// (SC-262). The assertions below are unchanged English — that is what shows
// the extraction moved no copy.
addUiLocale('en', {
  ui: {
    dataView: {
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

// A host registering its list nouns — what the two apps do at boot (SC-257).
addUiLocale('en', {
  ui: {
    dataView: {
      noun: {
        holdings_one: 'holding',
        holdings_other: 'holdings',
        holdings_counted_one: '{{count}} holding',
        holdings_counted_other: '{{count}} holdings',
      },
    },
  },
});

/**
 * `RefineSheet` itself renders nothing under `renderToStaticMarkup` — it is a
 * Radix portal — so the three pieces it composes are exported and asserted on
 * here. Which is also the shape of V3-39: the ticket is about what is above
 * the fold (the header), what order the axes come in (the sections) and what
 * the primary button claims to do (the footer).
 *
 * The `<Sheet open>` wrapper is Radix's dialog context, which `SheetTitle` and
 * `SheetDescription` read. It renders no DOM of its own.
 */
function render(node: ReactElement): string {
  return renderToStaticMarkup(<Sheet open>{node}</Sheet>);
}

// The def set `holdingsConfig.tsx` passes — the surface the bug was filed
// against, and the largest of the six consumers.
const FILTER_DEFS = [
  {
    key: 'tokenType',
    labelKey: 'ui.dataView.test.type',
    options: [
      { value: 'crypto', label: 'Cryptocurrency' },
      { value: 'fiat', label: 'Fiat Currency' },
    ],
    fn: () => true,
  },
  { key: 'institution', labelKey: 'ui.dataView.test.institution', options: [], fn: () => true },
  { key: 'account', labelKey: 'ui.dataView.test.account', options: [], fn: () => true },
  { key: 'group', labelKey: 'ui.dataView.test.group', options: [], fn: () => true },
] as unknown as V3FilterDef[];

const SORT_DEFS: V3SortDef[] = [
  { key: 'value', labelKey: 'ui.dataView.test.value' },
  { key: 'symbol', labelKey: 'ui.dataView.test.symbol' },
];

const GROUP_BY_DEFS = [
  { key: 'institution', labelKey: 'ui.dataView.test.institution', fn: () => '' },
] as unknown as V3GroupByDef[];

function sections(filters: Record<string, string> = {}): string {
  return render(
    <RefineSections
      filters={filters}
      filterDefs={FILTER_DEFS}
      onSetFilter={() => {}}
      sortField="value"
      sortDirection="desc"
      sortDefs={SORT_DEFS}
      onSetSort={() => {}}
      groupBy=""
      groupByDefs={GROUP_BY_DEFS}
      onSetGroupBy={() => {}}
    />
  );
}

describe('RefineSections — the order the axes come in', () => {
  /**
   * The first half of V3-39. Filtering is why anyone opens this on a long
   * list; sorting is what they do once. With sort and group first, the two of
   * them filled the sheet's rest height on a 390px phone and the user reported
   * filters as missing from a sheet that had them all along.
   */
  test('filter comes before sort, and sort before group', () => {
    const html = sections();
    const filter = html.indexOf('Filter');
    const sort = html.indexOf('Sort by');
    const group = html.indexOf('Group by');
    expect(filter).toBeGreaterThan(-1);
    expect(filter).toBeLessThan(sort);
    expect(sort).toBeLessThan(group);
  });

  test('every filter axis is offered, each showing what it is set to', () => {
    const html = sections();
    for (const label of ['Type', 'Institution', 'Account', 'Group']) {
      expect(html).toInclude(label);
    }
    expect(html).toInclude('Any');
  });

  // Collapsed is what makes "filters first" fit: four axes in four rows rather
  // than four walls of options. The ones already doing something open.
  test('an axis that is filtering opens with its options', () => {
    const html = sections({ tokenType: 'crypto' });
    expect(html).toInclude('Cryptocurrency');
    expect(html).toInclude('Fiat Currency');
  });

  test('an axis that is not filtering stays collapsed', () => {
    expect(sections()).not.toInclude('Fiat Currency');
  });
});

describe('RefineHeader — the count, above the fold', () => {
  test('states the live result count and that changes are live', () => {
    const html = render(<RefineHeader nounKey="ui.dataView.noun.holdings" filteredCount={69} />);
    expect(html).toInclude('69 holdings');
    expect(html).toInclude('changes apply as you make them');
  });

  test('the count is announced when it moves', () => {
    expect(
      render(<RefineHeader nounKey="ui.dataView.noun.holdings" filteredCount={69} />)
    ).toInclude('aria-live="polite"');
  });

  test('one result is one noun', () => {
    const html = render(<RefineHeader nounKey="ui.dataView.noun.holdings" filteredCount={1} />);
    expect(html).toInclude('1 holding ');
  });
});

describe('RefineFooter — the button is a dismiss, and says so', () => {
  /**
   * The third half of V3-39: a sheet cannot both apply changes as they are
   * made and offer a button that reads like the apply. `Show 69 holdings` was
   * the latter; the count moved to the header, where it is information rather
   * than a promise.
   */
  test('the primary action is Done, not an apply', () => {
    const html = renderToStaticMarkup(
      <RefineFooter hasActiveFilters onClearFilters={() => {}} onOpenChange={() => {}} />
    );
    expect(html).toInclude('Done');
    expect(html).not.toInclude('Show ');
    expect(html).toInclude('Clear all');
  });

  test('clearing is offered only when there is something to clear', () => {
    const html = renderToStaticMarkup(
      <RefineFooter hasActiveFilters={false} onClearFilters={() => {}} onOpenChange={() => {}} />
    );
    expect(html).toInclude('disabled');
  });

  // The bar sits on the bottom edge of the phone, where the home indicator is.
  test('clears the home indicator', () => {
    const html = renderToStaticMarkup(
      <RefineFooter hasActiveFilters onClearFilters={() => {}} onOpenChange={() => {}} />
    );
    expect(html).toInclude('safe-area-inset-bottom');
  });
});
