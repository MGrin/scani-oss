import { describe, expect, it } from 'bun:test';
import { RenderPdfInput } from '@scani/shared';
import { createElement } from 'react';
import { addUiLocale } from '../../../../src/i18n';
import type { V3DataViewConfig } from '../../../../src/v3/lib/data-view';
import { exportMoney } from '../../../../src/v3/lib/export/cell';
import {
  buildDataViewSheets,
  describeExportScope,
  exportAllScopeLabel,
  nodeText,
} from '../../../../src/v3/lib/export/data-view';
import { toExportBlob } from '../../../../src/v3/lib/export/format';
import { provenanceLines } from '../../../../src/v3/lib/export/workbook';

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

interface Holding {
  id: string;
  symbol: string;
  account: string;
  value: string;
}

const HOLDINGS: Holding[] = [
  { id: '1', symbol: 'BTC', account: 'Kraken Spot', value: '73782.10' },
  { id: '2', symbol: 'ETH', account: 'Binance Spot', value: '53898.00' },
];

function config(): V3DataViewConfig<Holding> {
  return {
    pageKey: 'holdings',
    data: HOLDINGS,
    nounKey: 'ui.dataView.noun.holdings',
    renderRow: (item) => ({ label: item.symbol, value: item.value }),
    empty: { icon: (() => null) as never, titleKey: 'ui.dataView.test.none', action: null },
    columns: [
      { key: 'symbol', headerKey: 'ui.dataView.test.holding', render: (item) => item.symbol },
      {
        key: 'account',
        headerKey: 'ui.dataView.test.account',
        render: (item) => createElement('span', null, item.account),
      },
      {
        key: 'value',
        headerKey: 'ui.dataView.test.value',
        numeric: true,
        render: () =>
          createElement(function Numeric() {
            return null;
          }),
        exportValue: (item) => exportMoney(item.value, 'EUR'),
      },
    ],
    sortDefs: [{ key: 'value', labelKey: 'ui.dataView.test.value' }],
    groupByDefs: [
      { key: 'account', labelKey: 'ui.dataView.test.account', fn: (item: Holding) => item.account },
    ],
  };
}

const BASE = {
  items: HOLDINGS,
  groupBy: '',
  filtered: false,
  filteredCount: 2,
  totalCount: 2,
  activeFilters: [],
  searchTerm: '',
  sortField: 'value',
  sortDirection: 'desc' as const,
  generatedAt: new Date('2026-08-14T10:00:00.000Z'),
};

describe('nodeText', () => {
  it('recovers text from plain children', () => {
    expect(nodeText(createElement('span', null, 'Kraken Spot'))).toBe('Kraken Spot');
    expect(nodeText(createElement('span', null, createElement('b', null, 'BTC'), ' spot'))).toBe(
      'BTC  spot'
    );
  });

  it('returns nothing for a component element, so a figure cannot arrive as text', () => {
    const Numeric = () => null;
    expect(nodeText(createElement(Numeric))).toBe('');
  });
});

describe('buildDataViewSheets', () => {
  it('follows the visible table: same columns, same order', () => {
    const {
      sheets: [data],
    } = buildDataViewSheets({ config: config(), ...BASE });
    expect(data?.headers).toEqual(['Holding', 'Account', 'Value (EUR)']);
    expect(data?.rows).toHaveLength(2);
  });

  it('recovers a plain-text column from its render and a figure from exportValue', () => {
    const {
      sheets: [data],
    } = buildDataViewSheets({ config: config(), ...BASE });
    expect(data?.rows[0]?.[1]).toEqual({ kind: 'text', value: 'Kraken Spot' });
    // `73782.10`, not `73782.1`: a money figure leaves the sheet already at the
    // decimals it declares, so every writer renders the same digits (SC-174).
    expect(data?.rows[0]?.[2]).toMatchObject({
      kind: 'number',
      value: '73782.10',
      decimals: 2,
      style: 'money',
    });
  });

  it('puts the group-by in front as a column of its own', () => {
    const grouped = config();
    grouped.groupByDefs = [
      {
        key: 'institution',
        labelKey: 'ui.dataView.test.institution',
        fn: (item: Holding) => item.account.split(' ')[0] as string,
      },
    ];
    const {
      sheets: [data],
    } = buildDataViewSheets({ config: grouped, ...BASE, groupBy: 'institution' });
    expect(data?.headers[0]).toBe('Institution');
    expect(data?.rows[0]?.[0]).toEqual({ kind: 'text', value: 'Kraken' });
  });

  it('skips a group column the table already has, rather than repeating it', () => {
    // `/holdings` grouped by account shipped two adjacent `Account` columns
    // holding the same values. The grouping is only information in the file
    // when the columns do not already carry it.
    const {
      sheets: [data],
    } = buildDataViewSheets({ config: config(), ...BASE, groupBy: 'account' });
    expect(data?.headers).toEqual(['Holding', 'Account', 'Value (EUR)']);
  });

  it('carries the filters and the sort as provenance, never as data rows', () => {
    const { sheets, provenance } = buildDataViewSheets({
      config: config(),
      ...BASE,
      filtered: true,
      filteredCount: 1,
      searchTerm: 'btc',
      activeFilters: [{ key: 'institution', label: 'Institution', value: 'Kraken' }],
    });
    // The data sheet stays a header row and data rows. Since SC-93 the
    // provenance travels alongside it as a field rather than as `sheets[1]`,
    // which is what lets the CSV writer render it as a preamble instead of
    // dropping it.
    expect(sheets[0]?.headers).toEqual(['Holding', 'Account', 'Value (EUR)']);
    expect(sheets).toHaveLength(1);

    const lines = provenanceLines(provenance).map((l) => `${l.label}: ${l.value}`);
    expect(lines).toContain('Scope: Filtered — 1 of 2 holdings');
    expect(lines).toContain('Search: btc');
    expect(lines).toContain('Institution: Kraken');
    expect(lines).toContain('Sorted by: Value, high to low');
    expect(lines).toContain('Rows: 2');
  });

  it('withholds every value column when hideAmounts is set', () => {
    const { sheets, provenance } = buildDataViewSheets({
      config: config(),
      ...BASE,
      hideAmounts: true,
    });
    expect(sheets[0]?.headers).toEqual(['Holding', 'Account']);
    expect(provenance.amountsWithheld).toBe(true);
  });
});

describe('describeExportScope', () => {
  it('says which set is leaving and how big it is', () => {
    expect(describeExportScope({ config: config(), ...BASE })).toBe('All 2 holdings');
    expect(
      describeExportScope({ config: config(), ...BASE, filtered: true, filteredCount: 1 })
    ).toBe('Filtered — 1 of 2 holdings');
  });

  /**
   * SC-244. A file outlives the screen it left: "All 2 holdings" opened next
   * month carries no trace that the account holds five hundred and this was
   * page one.
   */
  it('does not call a page "all"', () => {
    expect(describeExportScope({ config: config(), ...BASE, partial: true })).toBe(
      'All 2 holdings loaded so far'
    );
    expect(
      describeExportScope({
        config: config(),
        ...BASE,
        partial: true,
        filtered: true,
        filteredCount: 1,
      })
    ).toBe('Filtered — 1 of 2 holdings loaded so far');
  });

  it('and the button that produced the file says the same thing', () => {
    expect(exportAllScopeLabel('ui.dataView.noun.holdings', 2, false)).toBe('All 2 holdings');
    expect(exportAllScopeLabel('ui.dataView.noun.holdings', 2, true)).toBe('All 2 holdings loaded');
  });

  /**
   * The bytes, for the path every list export takes (SC-316).
   *
   * `buildDataViewSheets` resolves twelve surfaces' column headers, group
   * labels, nouns and provenance against `@scani/ui`'s own instance. Until this
   * assertion existed the only thing standing between a wrong instance and a
   * spreadsheet full of `ui.dataView.holdings.col.amount` was the partial-set
   * test below, which happens to read two provenance lines. The app's twin of
   * this lives in `apps/frontend/app/tests/v3/lib/export-artifact.test.ts`.
   */
  it('writes no raw ui.* key into a list CSV', async () => {
    const workbook = buildDataViewSheets({
      config: config(),
      ...BASE,
      filtered: true,
      filteredCount: 1,
      searchTerm: 'btc',
      partial: true,
    });
    const text = await (await toExportBlob(workbook, 'csv', ',')).text();

    expect(text).not.toMatch(/\bui\.[a-z][a-zA-Z]*\.[a-zA-Z.]+/);
    expect(text).toContain('# Subject: Holdings');
    expect(text).toContain('# Search: btc');
    expect(text).toContain('# Sorted by: Value, high to low');
    expect(text).toContain('Holding,Account,Value (EUR)');
  });

  /** The About sheet is the only place a partial export can still say so. */
  it('records the partial set in the file itself', () => {
    const workbook = buildDataViewSheets({ config: config(), ...BASE, partial: true });
    const lines = provenanceLines(workbook.provenance).map((l) => `${l.label}: ${l.value}`);
    expect(lines).toContain('Scope: All 2 holdings loaded so far');
    expect(lines).toContain(
      'Not the whole set: Only the 2 holdings loaded on screen were exported.'
    );
  });
});

describe('the grouped export, and the PDF wire contract', () => {
  const grouped = () => {
    const withInstitution = config();
    withInstitution.groupByDefs = [
      {
        key: 'institution',
        labelKey: 'ui.dataView.test.institution',
        fn: (item: Holding) => item.account.split(' ')[0] as string,
      },
    ];
    return withInstitution;
  };

  it('orders the rows the way the grouped screen does, and says where the runs are', () => {
    // Until SC-94 the file was the *flat* sorted list with a group column
    // beside it, while the screen showed the same rows in group order. Two
    // orders for one list, and the file's was the one nobody looked at. A
    // heading is only possible over a contiguous run, so the PDF needs this too.
    const {
      sheets: [data],
    } = buildDataViewSheets({
      config: grouped(),
      ...BASE,
      items: [...HOLDINGS, { id: '3', symbol: 'SOL', account: 'Kraken Staking', value: '1.00' }],
      groupBy: 'institution',
    });
    expect(data?.groups).toEqual([
      { label: 'Kraken', rowCount: 2 },
      { label: 'Binance', rowCount: 1 },
    ]);
    expect(data?.rows.map((row) => row[1])).toEqual([
      { kind: 'text', value: 'BTC' },
      { kind: 'text', value: 'SOL' },
      { kind: 'text', value: 'ETH' },
    ]);
  });

  it('names the group column, so the statement can drop the one it repeats', () => {
    const {
      sheets: [data],
    } = buildDataViewSheets({ config: grouped(), ...BASE, groupBy: 'institution' });
    expect(data?.groupColumn).toBe(0);
  });

  it('leaves the group column unnamed when the table already had that column', () => {
    const {
      sheets: [data],
    } = buildDataViewSheets({ config: config(), ...BASE, groupBy: 'account' });
    expect(data?.groupColumn).toBeUndefined();
    expect(data?.groups).toHaveLength(2);
  });

  it('marks only the columns a surface declared additive', () => {
    // Being money is not being additive — see `V3ColumnDef.exportTotal`.
    const declared = config();
    (declared.columns[2] as { exportTotal?: boolean }).exportTotal = true;
    const {
      sheets: [data],
    } = buildDataViewSheets({ config: declared, ...BASE });
    expect(data?.totalColumns).toEqual([false, false, true]);

    const {
      sheets: [undeclared],
    } = buildDataViewSheets({ config: config(), ...BASE });
    expect(undeclared?.totalColumns).toEqual([false, false, false]);
  });

  it('builds a document the render endpoint accepts', () => {
    // The client assembles the document and the server only typesets it, so the
    // one thing that can break between them is the *shape*. This parses what
    // the client would actually send through the server's own schema — the two
    // sides share `@scani/shared`, and this is the assertion that they do.
    const workbook = buildDataViewSheets({
      config: grouped(),
      ...BASE,
      groupBy: 'institution',
    });
    const parsed = RenderPdfInput.safeParse({
      sheet: workbook.sheets[0],
      provenance: {
        ...workbook.provenance,
        generatedAt: workbook.provenance.generatedAt.toISOString(),
      },
    });
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it('is rejected when the runs do not cover the rows', () => {
    const workbook = buildDataViewSheets({
      config: grouped(),
      ...BASE,
      groupBy: 'institution',
    });
    const parsed = RenderPdfInput.safeParse({
      sheet: { ...workbook.sheets[0], groups: [{ label: 'Kraken', rowCount: 99 }] },
      provenance: {
        ...workbook.provenance,
        generatedAt: workbook.provenance.generatedAt.toISOString(),
      },
    });
    expect(parsed.success).toBe(false);
  });
});
