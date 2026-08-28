import { describe, expect, test } from 'bun:test';
import { addUiLocale } from '@scani/ui/i18n';
import { DataViewSkeleton } from '@scani/ui/v3/components/data-view/DataViewSkeleton';
import { DataViewGroupHeading, V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import type { V3DataViewConfig } from '@scani/ui/v3/lib/data-view';
import { SETTLED_QUERY_STATE, type V3QueryState } from '@scani/ui/v3/lib/query-state';
import { Wallet } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { renderDesktop } from '../../../helpers/render-desktop';

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

/** What `describeQueryError` reads as an ordinary server failure. */
const SERVER_ERROR = { data: { httpStatus: 500 }, message: 'INTERNAL_SERVER_ERROR' };

/**
 * `renderToStaticMarkup` has no `window`, so `useIsDesktop()` resolves false —
 * which is the phone surface, and the one v3 is designed against. The table is
 * covered separately in `DataViewTable.test.tsx`.
 *
 * `StaticRouter` is required rather than incidental: since V3-11 the surface
 * reads the location so a row can open its record at a URL of its own.
 */

interface Holding {
  id: string;
  symbol: string;
  institution: string;
  value: number;
  change: number;
}

const HOLDINGS: Holding[] = [
  { id: 'a', symbol: 'BTC', institution: 'Kraken', value: 18_204.55, change: 2.14 },
  { id: 'b', symbol: 'ETH', institution: 'Coinbase', value: 3180.4, change: -1.08 },
  { id: 'c', symbol: 'VWRA', institution: 'Interactive Brokers', value: 128_400.62, change: 0.37 },
];

function config(overrides: Partial<V3DataViewConfig<Holding>> = {}): V3DataViewConfig<Holding> {
  return {
    pageKey: 'test-holdings',
    nounKey: 'ui.dataView.noun.holdings',
    data: HOLDINGS,
    searchFn: (item, query) => item.symbol.toLowerCase().includes(query),
    sortDefs: [{ key: 'value', labelKey: 'ui.dataView.test.value' }],
    sortFn: (a, b, _field, direction) =>
      direction === 'asc' ? a.value - b.value : b.value - a.value,
    defaultSort: { field: 'value', direction: 'desc' },
    groupByDefs: [
      {
        key: 'institution',
        labelKey: 'ui.dataView.test.institution',
        fn: (i: Holding) => i.institution,
      },
    ],
    filterDefs: [
      {
        key: 'institution',
        labelKey: 'ui.dataView.test.institution',
        options: [{ value: 'Kraken', label: 'Kraken' }],
        fn: (i: Holding, v: string) => i.institution === v,
      },
    ],
    renderRow: (item) => ({
      label: item.symbol,
      sublabel: item.institution,
      value: <Numeric value={item.value} currency="USD" />,
      delta: <Numeric value={item.change} format="percent" delta />,
    }),
    columns: [
      { key: 'symbol', headerKey: 'ui.dataView.test.holding', render: (i) => i.symbol },
      {
        key: 'value',
        headerKey: 'ui.dataView.test.value',
        numeric: true,
        render: (i) => String(i.value),
      },
    ],
    empty: {
      icon: Wallet,
      titleKey: 'ui.dataView.test.noHoldingsYet',
      descriptionKey: 'ui.dataView.test.connectAnExchangeAndYour',
      action: <button type="button">Connect an exchange</button>,
    },
    ...overrides,
  };
}

/** `renderToStaticMarkup` runs no effects, so `useDelayedLoading` is pinned at
 *  its initial `idle` — which makes every render below the *first frame* of a
 *  surface. That is exactly the frame V3-16 is about: at 0ms a loading list
 *  must draw nothing at all. */
function render(
  overrides: Partial<V3DataViewConfig<Holding>> = {},
  query?: Partial<V3QueryState>,
  path = '/holdings'
) {
  return renderToStaticMarkup(
    <StaticRouter location={path}>
      <V3DataView
        config={config(overrides)}
        getId={(item) => item.id}
        query={query ? { ...SETTLED_QUERY_STATE, ...query } : undefined}
      />
    </StaticRouter>
  );
}

describe('V3DataView — the phone surface', () => {
  /**
   * The guarantee every hero figure on a data view depends on. Computed over
   * the whole set instead, a total is a wrong number on screen sitting next to
   * a count line that says the list is narrowed — two contradictory claims
   * about the same data, which is exactly how V3-32 shipped.
   */
  test('the summary is handed the filtered rows, never the whole set', () => {
    const html = render({
      defaultFilters: { institution: 'Kraken' },
      summary: (items) => <p>Summing {items.map((item) => item.symbol).join(', ')}</p>,
    });
    expect(html).toInclude('Summing BTC');
    expect(html).not.toInclude('ETH');
    expect(html).not.toInclude('VWRA');
  });

  test('renders rows, not a table', () => {
    const html = render();
    expect(html).toInclude('BTC');
    expect(html).not.toInclude('<table');
  });

  // The ticket in one assertion: v2 wrapped its table in `overflow-x-auto` and
  // floored it at `min-w-[700px]`, so the row label and the figure could not be
  // on screen together on a phone.
  test('nothing on the phone surface scrolls sideways', () => {
    const html = render();
    expect(html).not.toInclude('overflow-x-auto');
    expect(html).not.toInclude('min-w-[700px]');
  });

  test('sorts through the v2 hook’s config, unforked', () => {
    const html = render();
    expect(html.indexOf('VWRA')).toBeLessThan(html.indexOf('BTC'));
    expect(html.indexOf('BTC')).toBeLessThan(html.indexOf('ETH'));
  });

  test('is one surface with hairlines in it, not a card per row', () => {
    const html = render();
    expect(html).toInclude('divide-y divide-border');
    // Three rows, one list, no per-row border or shadow.
    expect(html.match(/<li>/g)).toHaveLength(3);
    expect(html).not.toInclude('shadow');
  });
});

describe('DataViewGroupHeading', () => {
  test('carries the count, which is what the grouping was for', () => {
    const html = renderToStaticMarkup(
      <DataViewGroupHeading label="Interactive Brokers" count={8} />
    );
    expect(html).toInclude('Interactive Brokers');
    expect(html).toInclude('>8<');
    expect(html).toInclude('tabular-nums');
  });

  test('a long group name truncates rather than pushing the count off screen', () => {
    const html = renderToStaticMarkup(
      <DataViewGroupHeading label="A brokerage with an unreasonably long legal name" count={2} />
    );
    expect(html).toInclude('truncate');
    expect(html).toInclude('shrink-0');
  });
});

describe('V3DataView — refinement is a destination', () => {
  test('offers one control, not a strip of selects', () => {
    const html = render();
    expect(html).toInclude('aria-label="Filter, sort and group"');
    // The sheet is closed, so its contents are not in the document at all.
    expect(html).not.toInclude('Sort by');
    expect(html).not.toInclude('Group by');
  });

  test('search is 16px so iOS does not zoom the page on focus', () => {
    expect(render()).toInclude('text-body');
  });
});

describe('V3DataView — the count line', () => {
  test('states the total when nothing is narrowing', () => {
    expect(render()).toInclude('3 holdings');
  });

  test('is absent while loading', () => {
    expect(render({}, { isLoading: true })).not.toInclude('3 holdings');
  });
});

describe('V3DataView — empty is not filtered-empty', () => {
  test('a genuinely empty surface gets its own words and its own action', () => {
    const html = render({ data: [] });
    expect(html).toInclude('No holdings yet');
    expect(html).toInclude('Connect an exchange');
    expect(html).not.toInclude('No items found');
  });

  test('a filtered-to-empty surface offers the button that undoes the filter', () => {
    const html = render({ data: HOLDINGS, defaultFilters: { institution: 'Nowhere' } });
    expect(html).toInclude('No holdings match those filters');
    expect(html).toInclude('Clear search and filters');
    // Not the onboarding action — the user has holdings, they just filtered
    // them all away.
    expect(html).not.toInclude('No holdings yet');
  });

  test('an active filter is visible as a removable chip', () => {
    const html = render({ defaultFilters: { institution: 'Kraken' } });
    expect(html).toInclude('aria-label="Remove filter Institution: Kraken"');
    expect(html).toInclude('1 of 3 holdings');
  });

  test('filter chips wrap rather than scrolling out of sight', () => {
    const html = render({ defaultFilters: { institution: 'Kraken' } });
    expect(html).toInclude('flex-wrap');
    expect(html).not.toInclude('overflow-x-auto');
  });
});

/**
 * SC-244 — the third empty screen.
 *
 * The defect: a surface fed by `useInfiniteQuery` narrowed the page it held and
 * reported the result in the words it uses for a reader who owns nothing. The
 * distinguishing fact rides in on `query.more`, so every assertion below is
 * about the SAME data with and without it.
 */
describe('V3DataView — narrowing a page is not searching a set', () => {
  const MORE = { fetch: () => {}, isFetching: false };
  const partial = (query: Partial<V3QueryState> = {}) => ({ more: MORE, ...query });

  test('a filter that matched nothing on this page does not claim the set is empty', () => {
    const html = render({ data: HOLDINGS, defaultFilters: { institution: 'Nowhere' } }, partial());
    expect(html).toInclude('No matches in what is loaded');
    expect(html).toInclude('Search and filters only see the 3 holdings loaded so far');
    // The sentence the same code renders when the narrowing DID see everything.
    expect(html).not.toInclude('No holdings match those filters');
  });

  test('the way out of that screen is loading more, not clearing the filter', () => {
    const html = render({ data: HOLDINGS, defaultFilters: { institution: 'Nowhere' } }, partial());
    expect(html).toInclude('Load more');
    // Still offered — it is just no longer the only thing on offer.
    expect(html).toInclude('Clear search and filters');
  });

  test('the same filter over a complete set keeps the settled words and no Load more', () => {
    const html = render({ data: HOLDINGS, defaultFilters: { institution: 'Nowhere' } });
    expect(html).toInclude('No holdings match those filters');
    expect(html).not.toInclude('No matches in what is loaded');
    expect(html).not.toInclude('Load more');
  });

  test('the count line stops presenting the page as the total', () => {
    expect(render({}, partial())).toInclude('3 holdings loaded so far');
    expect(render({})).not.toInclude('loaded so far');
  });

  test('a narrowed count line says which set it narrowed', () => {
    const html = render({ defaultFilters: { institution: 'Kraken' } }, partial());
    expect(html).toInclude('1 of 3 holdings loaded so far');
  });

  test('Load more sits under the rows, not inside them', () => {
    const html = render({}, partial());
    expect(html).toInclude('Load more');
    expect(html.indexOf('Load more')).toBeGreaterThan(html.indexOf('BTC'));
  });

  /**
   * A local filter over a page is still about the page, even on a surface whose
   * SEARCH is the server's. The two narrowings have different reach and the
   * empty screen follows the one that actually ran.
   */
  test('a remote-search surface still says so about its local filter', () => {
    const html = render(
      { data: HOLDINGS, defaultFilters: { institution: 'Nowhere' }, onSearch: () => {} },
      partial()
    );
    expect(html).toInclude('No matches in what is loaded');
  });
});

describe('V3DataView — the loading ramp (V3-16)', () => {
  /** The whole ticket in one assertion. v2 rendered five bars at 0ms, so a
   *  cached list — which is most of them — flashed a placeholder it never
   *  needed. Nothing is drawn until the 300ms band. */
  test('draws no placeholder in the first frame', () => {
    const html = render({ data: [] }, { isLoading: true });
    expect(html).not.toInclude('aria-busy');
    expect(html).not.toInclude('animate-pulse');
  });

  test('an unsettled surface is not an empty one', () => {
    const html = render({ data: [] }, { isLoading: true });
    // The onboarding copy is a claim about the account, and a request that has
    // not answered yet is not evidence for it.
    expect(html).not.toInclude('No holdings yet');
    expect(html).not.toInclude('No holdings match those filters');
  });

  test('the skeleton itself is shaped like the list and carries no live region', () => {
    const html = renderToStaticMarkup(<DataViewSkeleton />);
    expect(html).toInclude('divide-y divide-border');
    // `LoadingRamp` owns the announcement; six self-announcing rectangles is
    // what a screen reader would otherwise be asked to read.
    expect(html).not.toInclude('aria-busy');
    expect(html).not.toInclude('sr-only');
  });
});

describe('V3DataView — a failed read is not an empty account', () => {
  test('takes the surface, with the retry, when there is nothing to show', () => {
    const html = render({ data: [] }, { isError: true, error: SERVER_ERROR });
    expect(html).toInclude('load holdings');
    expect(html).toInclude('Try again');
    expect(html).not.toInclude('No holdings yet');
    // A search box over a surface that has no data to search.
    expect(html).not.toInclude('aria-label="Search holdings"');
  });

  test('leaves a list that is already on screen standing', () => {
    const html = render({}, { isError: true, error: SERVER_ERROR });
    expect(html).toInclude('BTC');
    expect(html).not.toInclude('load holdings');
  });
});

describe('V3DataView — the peek sheet', () => {
  const peek: V3DataViewConfig<Holding>['peek'] = {
    basePath: '/holdings',
    render: (item) => ({
      title: item.symbol,
      primary: [{ label: 'Venue', value: item.institution }],
    }),
  };

  // The peek is a sheet over the list, not a screen instead of it — which is
  // the difference between the peek pattern and navigating to a detail page,
  // and the reason the record's URL is a child of the list's.
  test('a deep-linked record leaves the list standing behind it', () => {
    const html = render({ peek }, undefined, '/holdings/a');
    expect(html).toInclude('BTC');
    expect(html).toInclude('ETH');
  });

  // Radix portals render nothing before mount, so the sheet's own markup is
  // covered in `PeekSheet.test.tsx` rather than here.
  test('the sheet is portalled, so the surface does not inline it', () => {
    expect(render({ peek }, undefined, '/holdings/a')).not.toInclude('Venue');
  });
});

describe('V3DataView — bulk selection', () => {
  test('the Select control appears only when the surface has bulk actions', () => {
    expect(render()).not.toInclude('>Select<');
    expect(render({ renderBulkActions: () => <button type="button">Refresh</button> })).toInclude(
      '>Select<'
    );
  });
});

/**
 * SC-797 — the branch nothing rendered.
 *
 * Every test above this point renders through `renderToStaticMarkup`, which has
 * no `window`, so `useIsDesktop()` resolves false and all of them are about the
 * phone surface. `DataViewTable.test.tsx` covers the table, but it hands the
 * table its props directly — so between the two files nothing had ever checked
 * what `V3DataView` PASSES to the table, which is where SC-625's dash came
 * from: a green assertion found its string on the card beside the column.
 *
 * `renderDesktop` throws if nothing read its `matchMedia` stub, so a stub that
 * stops taking is a failure rather than a silent re-run of the phone surface.
 * That is a claim about the HOOK; `<table` below is the claim about the BRANCH,
 * and every test here carries one.
 */
function renderDesk(
  overrides: Partial<V3DataViewConfig<Holding>> = {},
  query?: Partial<V3QueryState>,
  path = '/holdings'
) {
  return renderDesktop(
    <StaticRouter location={path}>
      <V3DataView
        config={config(overrides)}
        getId={(item) => item.id}
        query={query ? { ...SETTLED_QUERY_STATE, ...query } : undefined}
      />
    </StaticRouter>
  );
}

describe('V3DataView — the desktop surface', () => {
  test('renders the table instead of the row list, not as well as it', () => {
    const html = renderDesk();
    // MUST-BE-FOUND. Without it a stub that stops taking renders the card list
    // and every assertion below passes for the wrong surface.
    expect(html).toInclude('<table');
    // The row list's own marker — `V3DataView` picks in JS precisely so the
    // rows are not mounted twice behind `hidden lg:block`.
    expect(html).not.toInclude('divide-y divide-border');
  });

  test('the table is handed the same rows, in the same order, as the card list', () => {
    const desktop = renderDesk();
    const phone = render();
    expect(desktop).toInclude('<table');
    for (const symbol of ['VWRA', 'BTC', 'ETH']) {
      expect(desktop).toInclude(symbol);
      expect(phone).toInclude(symbol);
    }
    // Sorted by value descending on both, from one `sortFn`.
    expect(desktop.indexOf('VWRA')).toBeLessThan(desktop.indexOf('BTC'));
    expect(desktop.indexOf('BTC')).toBeLessThan(desktop.indexOf('ETH'));
  });

  /**
   * The SC-625 shape, as an assertion. A filter that narrows the surface has to
   * narrow the TABLE — a column rendering a row the count line says was filtered
   * out is a wrong list on screen beside a correct sentence about it.
   */
  test('a filter reaches the table, so the count line and the rows agree', () => {
    const html = renderDesk({ defaultFilters: { institution: 'Kraken' } });
    expect(html).toInclude('<table');
    expect(html).toInclude('1 of 3 holdings');
    expect(html).toInclude('BTC');
    expect(html).not.toInclude('VWRA');
    expect(html).not.toInclude('ETH');
  });

  /**
   * Selection is a standing column on desktop and a MODE on a phone, so the
   * two surfaces offer different controls for the same capability. Both arms,
   * because "the toolbar has no Select" is also true of a surface with no bulk
   * actions at all.
   */
  test('selection stands in the table and leaves the toolbar, and the phone surface is the inverse', () => {
    const bulk = { renderBulkActions: () => <button type="button">Refresh</button> };
    const desktop = renderDesk(bulk);
    const phone = render(bulk);

    expect(desktop).toInclude('<table');
    expect(desktop).toInclude('aria-label="Select all"');
    expect(desktop).not.toInclude('>Select<');

    expect(phone).toInclude('>Select<');
    expect(phone).not.toInclude('aria-label="Select all"');
  });

  test('the current sort reaches the table’s own header control', () => {
    const html = renderDesk({
      columns: [
        { key: 'symbol', headerKey: 'ui.dataView.test.holding', render: (i) => i.symbol },
        {
          key: 'value',
          headerKey: 'ui.dataView.test.value',
          numeric: true,
          sortable: true,
          render: (i) => String(i.value),
        },
      ],
    });
    expect(html).toInclude('<table');
    expect(html).toInclude('aria-label="Sort by Value"');
    // `defaultSort` is value/desc, and the arrow is how the table says so.
    expect(html).toInclude('lucide-arrow-down');
  });

  // Grouping is deliberately not covered here, on either surface: `groupBy`
  // starts empty and is only ever set from the URL by `useDataViewUrlState`,
  // which syncs in an effect — and `renderToStaticMarkup` runs no effects. The
  // table's own spanning header is covered in `DataViewTable.test.tsx`, which
  // hands it groups directly.

  /**
   * SC-118: a row that opens a page is a real link on desktop, which is what
   * restores Cmd-click and "Open in new tab". A PEEK list has no page to open,
   * so `V3DataView` withholds `rowHref` from the table — the one wiring rule
   * here that is a decision rather than a pass-through.
   */
  test('rows that open a page are links; rows that open a peek are not', () => {
    const withPage = renderDesk({ rowHref: (item) => `/holdings/${item.id}` });
    expect(withPage).toInclude('<table');
    expect(withPage).toInclude('href="/holdings/a"');

    const withPeek = renderDesk({
      rowHref: (item) => `/holdings/${item.id}`,
      peek: {
        basePath: '/holdings',
        render: (item) => ({ title: item.symbol, primary: [] }),
      },
    });
    expect(withPeek).toInclude('<table');
    expect(withPeek).not.toInclude('href="/holdings/a"');
  });

  /** Both branches sit behind `!isEmpty`, so the desktop surface must not draw
   *  a header row over nothing — an empty table is a spreadsheet's answer to a
   *  question the onboarding copy answers. */
  test('an empty surface draws the onboarding copy and no table at all', () => {
    const html = renderDesk({ data: [] });
    expect(html).toInclude('No holdings yet');
    expect(html).not.toInclude('<table');
  });
});
