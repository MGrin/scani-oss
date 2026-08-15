import { describe, expect, test } from 'bun:test';
import { DataViewTable } from '@scani/ui/v3/components/data-view/DataViewTable';
import type { V3ColumnDef } from '@scani/ui/v3/lib/data-view';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';

interface Holding {
  id: string;
  symbol: string;
  value: string;
}

const DATA: Holding[] = [
  { id: 'a', symbol: 'BTC', value: '$18,204.55' },
  { id: 'b', symbol: 'Wrapped Staked Ether, a name long enough to need the ellipsis', value: '—' },
];

const COLUMNS: V3ColumnDef<Holding>[] = [
  { key: 'symbol', header: 'Holding', sortable: true, width: 'w-[40%]', render: (i) => i.symbol },
  { key: 'value', header: 'Value', sortable: true, numeric: true, render: (i) => i.value },
];

function render(overrides: Partial<Parameters<typeof DataViewTable<Holding>>[0]> = {}) {
  return renderToStaticMarkup(
    <StaticRouter location="/holdings">
      <DataViewTable
        groups={[{ label: null, items: DATA }]}
        columns={COLUMNS}
        getId={(item) => item.id}
        selectable={false}
        selectedIds={new Set()}
        onToggleSelect={() => undefined}
        onSelectAll={() => undefined}
        onClearSelection={() => undefined}
        isAllSelected={false}
        sortField="value"
        sortDirection="desc"
        onSetSort={() => undefined}
        {...overrides}
      />
    </StaticRouter>
  );
}

describe('DataViewTable — no horizontal scroll, structurally', () => {
  // The two lines this ticket exists to delete: `overflow-x-auto` on the
  // wrapper and `min-w-[700px]` on the table (v2 `DataViewTable.tsx:74-75`).
  test('has no scroller and no minimum width', () => {
    const html = render();
    expect(html).not.toInclude('overflow-x-auto');
    expect(html).not.toInclude('overflow-auto');
    expect(html).not.toInclude('min-w-');
  });

  // Removing the scroller alone only moves the problem: an auto-layout table
  // still overflows its container when the content is wider than the box.
  // `table-fixed` is what makes the width a constraint rather than a result.
  test('is fixed-layout at exactly the container width', () => {
    const html = render();
    expect(html).toInclude('table-fixed');
    expect(html).toInclude('w-full');
  });

  test('identity cells truncate and numeric cells never do', () => {
    const html = render();
    const identityCell = html.slice(html.indexOf('<tbody'));
    expect(identityCell).toInclude('truncate');
    expect(identityCell).toInclude('whitespace-nowrap');
    // The figure is right-aligned and nowrap; it is not the zone that gives way.
    expect(html).toInclude('whitespace-nowrap text-right');
  });
});

describe('DataViewTable — sorting', () => {
  test('a sortable header is a real button, reachable by keyboard', () => {
    const html = render();
    expect(html).toInclude('aria-label="Sort by Holding"');
    // Not `min-h-tap`: inside `[data-ui='v3']` that utility is overridden by
    // the token layer at every pointer type (V3-25), so asserting it asserted
    // nothing. What the header owes is being a real button.
    expect(html).toInclude('<button type="button"');
  });

  test('a non-sortable header is not a button', () => {
    const html = render({
      columns: [{ key: 'symbol', header: 'Holding', render: (i: Holding) => i.symbol }],
    });
    expect(html).not.toInclude('<button');
  });

  test('the active column shows its direction and the others show they are sortable', () => {
    const html = render();
    expect(html).toInclude('lucide-arrow-down');
    expect(html).toInclude('lucide-arrow-up-down');
  });
});

describe('DataViewTable — grouping', () => {
  const GROUPED = [
    { label: 'Kraken', items: [DATA[0] as Holding] },
    { label: 'Interactive Brokers', items: [DATA[1] as Holding] },
  ];

  // One table per group repeats the header per group AND lets each table solve
  // its own column widths, so the figures stop landing in the same columns
  // exactly when the user asked to compare groups.
  test('is one table with one header, whatever the group count', () => {
    const html = render({ groups: GROUPED });
    expect(html.match(/<table/g)).toHaveLength(1);
    expect(html.match(/<thead/g)).toHaveLength(1);
    expect(html.match(/<tbody/g)).toHaveLength(2);
  });

  test('each group heading spans the full row and carries its count', () => {
    const html = render({ groups: GROUPED, selectable: true });
    // Two data columns plus the checkbox column. React's SSR emits the
    // attribute as `colSpan`; HTML attribute names are case-insensitive, so
    // the assertion is too.
    expect(html.toLowerCase()).toInclude('colspan="3"');
    expect(html).toInclude('scope="colgroup"');
    expect(html).toInclude('Kraken');
    expect(html).toInclude('Interactive Brokers');
  });

  test('an ungrouped list emits no heading row at all', () => {
    expect(render()).not.toInclude('colgroup');
  });
});

describe('DataViewTable — selection', () => {
  test('the checkbox column exists only when the surface has bulk actions', () => {
    expect(render()).not.toInclude('Select all');
    expect(render({ selectable: true })).toInclude('aria-label="Select all"');
  });

  test('the header checkbox clears rather than selects once something is selected', () => {
    const html = render({ selectable: true, selectedIds: new Set(['a']) });
    expect(html).toInclude('aria-label="Clear selection"');
  });
});

/**
 * SC-112. These checkboxes gate bulk delete, and every one of them was named
 * "Select row b10d1812-8573-49e7-…" — a name that passes an automated
 * accessibility rule (it is present) and identifies nothing. The confirm above
 * them names the count correctly; without this the reader cannot tell which
 * records the count is *of*.
 */
describe('DataViewTable — what a row checkbox is called', () => {
  test("takes the row's own name, not its id", () => {
    const html = render({ selectable: true, rowLabel: (item) => item.symbol });
    expect(html).toInclude('aria-label="Select BTC"');
    expect(html).not.toInclude('Select row');
  });

  test('falls back to the id only when the surface offers no name', () => {
    const html = render({ selectable: true, rowLabel: () => '' });
    expect(html).toInclude('aria-label="Select a"');
  });
});

/**
 * SC-118. Cmd+click on a row that leads to a page navigated the current tab:
 * the app honoured "go there" and ignored "without moving me", costing the
 * reader the place in the list they were trying to keep. A handler cannot fix
 * that — only a real link can.
 */
describe('DataViewTable — rows that lead to a page', () => {
  test('the identity cell is a link, so the browser can open it its own way', () => {
    const html = render({ rowHref: (item) => `/holdings/${item.id}`, onRowClick: () => undefined });
    expect(html).toInclude('href="/holdings/a"');
  });

  test('the link is not a second tab stop — the row already is one', () => {
    const html = render({ rowHref: (item) => `/holdings/${item.id}`, onRowClick: () => undefined });
    expect(html).toInclude('tabindex="-1"');
  });

  test('only the identity cell carries it, never the figures', () => {
    const html = render({ rowHref: (item) => `/holdings/${item.id}`, onRowClick: () => undefined });
    expect(html.split('<a ').length - 1).toBe(DATA.length);
  });

  test('a peek list is given no href and stays a run of buttons', () => {
    expect(render({ onRowClick: () => undefined })).not.toInclude('<a ');
  });
});
