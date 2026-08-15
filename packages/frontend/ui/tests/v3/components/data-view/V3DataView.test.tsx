import { describe, expect, test } from 'bun:test';
import { DataViewSkeleton } from '@scani/ui/v3/components/data-view/DataViewSkeleton';
import { DataViewGroupHeading, V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import type { V3DataViewConfig } from '@scani/ui/v3/lib/data-view';
import { SETTLED_QUERY_STATE, type V3QueryState } from '@scani/ui/v3/lib/query-state';
import { Wallet } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';

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
    noun: 'holdings',
    data: HOLDINGS,
    searchFn: (item, query) => item.symbol.toLowerCase().includes(query),
    sortDefs: [{ key: 'value', label: 'Value' }],
    sortFn: (a, b, _field, direction) =>
      direction === 'asc' ? a.value - b.value : b.value - a.value,
    defaultSort: { field: 'value', direction: 'desc' },
    groupByDefs: [{ key: 'institution', label: 'Institution', fn: (i: Holding) => i.institution }],
    filterDefs: [
      {
        key: 'institution',
        label: 'Institution',
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
      { key: 'symbol', header: 'Holding', render: (i) => i.symbol },
      { key: 'value', header: 'Value', numeric: true, render: (i) => String(i.value) },
    ],
    empty: {
      icon: Wallet,
      title: 'No holdings yet',
      description: 'Connect an exchange and your positions appear here.',
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
