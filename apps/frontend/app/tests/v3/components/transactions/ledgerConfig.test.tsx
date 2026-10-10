import '../../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CategoryCell,
  LedgerRangeEditor,
  ledgerAccountOptions,
  ledgerConfig,
  ledgerFilterDefs,
  ledgerFiltersFromView,
  ledgerHoldingOptions,
  ledgerListInput,
  ledgerSublabel,
  setCategoryMessage,
  toLedgerRows,
} from '../../../../src/v3/components/transactions/ledgerConfig';

describe('ledger filters, the Bills way (SC-1652)', () => {
  const nodes = [
    {
      id: 'food',
      name: 'Food',
      color: null,
      children: [{ id: 'groceries', name: 'Groceries', color: null, children: [] }],
    },
  ];
  const defs = ledgerFilterDefs({
    nodes,
    accounts: [{ id: 'a1', name: 'Kraken · Spot' }],
    holdings: [{ id: 'h1', label: 'BTC · Kraken · Spot' }],
  });

  test('category, account, holding and period, in the one filter sheet', () => {
    expect(defs.map((def) => def.key)).toEqual(['category', 'account', 'holding', 'period']);
  });

  test('categories are offered by path, after Uncategorized and Set automatically (SC-1695)', () => {
    const category = defs.find((def) => def.key === 'category');
    expect(category?.options.map((option) => option.value)).toEqual([
      'uncategorized',
      'auto',
      'food',
      'groceries',
    ]);
    expect(category?.options.map((option) => option.label)).toEqual([
      'Uncategorized',
      'Set automatically',
      'Food',
      'Food › Groceries',
    ]);
  });

  test('every def passes every row, because the server already narrowed them', () => {
    for (const def of defs) expect(def.fn?.({} as never, 'x')).toBe(true);
  });

  test('the period presets are the ones Bills uses for the past', () => {
    expect(defs.find((def) => def.key === 'period')?.options.map((o) => o.value)).toEqual([
      '30',
      '90',
      '365',
    ]);
  });

  test("the view's values become the server's filters", () => {
    expect(
      ledgerFiltersFromView({ category: 'food', account: 'a1', holding: 'h1', period: '90' })
    ).toEqual({ category: 'food', accountId: 'a1', holdingId: 'h1', periodDays: 90 });
  });

  test('a period that is not a preset is ignored rather than guessed', () => {
    expect(ledgerFiltersFromView({ period: 'yesterday' })).toEqual({});
  });

  test('asks the server for a category by id, or for the rows with none', () => {
    expect(ledgerListInput({ category: 'food' }, 0).category).toEqual({ id: 'food' });
    expect(ledgerListInput({ category: 'auto' }, 0).category).toBe('auto');
    expect(ledgerListInput({ category: 'uncategorized' }, 50)).toMatchObject({
      category: 'uncategorized',
      cursor: 50,
    });
  });

  test('a period starts at local midnight that many days ago', () => {
    const now = new Date(2026, 9, 10, 15, 30);
    expect(ledgerListInput({ periodDays: 30 }, 0, now).from).toEqual(new Date(2026, 8, 10));
    expect(ledgerListInput({}, 0, now).from).toBeUndefined();
  });
});

describe('the category cell (SC-1652)', () => {
  test('a row with no category says so, quietly', () => {
    const html = renderToStaticMarkup(<CategoryCell path={null} color={null} />);
    expect(html).toInclude('Uncategorized');
    expect(html).toInclude('text-muted-foreground');
  });

  test('a categorized row shows its path', () => {
    expect(renderToStaticMarkup(<CategoryCell path="Food › Groceries" color={null} />)).toInclude(
      'Food › Groceries'
    );
  });
});

describe('the account cell (SC-1652)', () => {
  const source = (holdingId: string) => ({
    id: `tx-${holdingId}`,
    occurredAt: '2026-09-05T00:00:00Z',
    description: 'Bought BTC',
    counterparty: null,
    quantity: '0.015',
    holdingId,
    categoryId: null,
    categorySetBy: null,
  });
  const holding = (id: string, account: string, institution: string) => ({
    id,
    account: { name: account },
    institution: { name: institution },
    token: { symbol: 'BTC', typeCode: 'crypto' },
  });

  test('names the account the way the Accounts page does, institution first', () => {
    const [row] = toLedgerRows([source('h1')], [holding('h1', 'Spot', 'Kraken')], [], () => '');
    expect(row?.accountName).toBe('Kraken · Spot');
  });

  test('does not repeat an institution the account name already says', () => {
    const [row] = toLedgerRows([source('h1')], [holding('h1', 'Kraken', 'Kraken')], [], () => '');
    expect(row?.accountName).toBe('Kraken');
  });
});

describe('the account filter (SC-1652)', () => {
  test('labels each account as the rows do, and keeps a bare name with no holdings', () => {
    const options = ledgerAccountOptions(
      [
        { id: 'a1', name: 'Spot' },
        { id: 'a2', name: 'Empty Wallet' },
      ],
      [{ account: { id: 'a1', name: 'Spot' }, institution: { name: 'Kraken' } }]
    );
    expect(options).toEqual([
      { id: 'a1', name: 'Kraken · Spot' },
      { id: 'a2', name: 'Empty Wallet' },
    ]);
  });
});

describe('the phone row (SC-1652)', () => {
  const row = {
    occurredAt: new Date(2026, 8, 5),
    accountName: 'YNAB · Everyday Checking',
    categoryPath: 'Food › Groceries',
  };

  test('puts the category before the account, so truncation cuts the account, not the category', () => {
    const line = ledgerSublabel(row);
    expect(line.indexOf('Food › Groceries')).toBeGreaterThan(-1);
    expect(line.indexOf('Food › Groceries')).toBeLessThan(line.indexOf('YNAB'));
  });

  test('an uncategorized row leaves the category out rather than printing a gap', () => {
    expect(ledgerSublabel({ ...row, categoryPath: null })).not.toInclude('·  ·');
  });
});

describe('the holding filter (SC-1652)', () => {
  test('names a holding by its token and its account, the way a row names the account', () => {
    expect(
      ledgerHoldingOptions([
        {
          id: 'h1',
          account: { name: 'Spot' },
          institution: { name: 'Kraken' },
          token: { symbol: 'BTC', typeCode: 'crypto' },
        },
      ])
    ).toEqual([{ id: 'h1', label: 'BTC · Kraken · Spot' }]);
  });
});

describe('a custom date range (SC-1652)', () => {
  const period = ledgerFilterDefs({ nodes: [], accounts: [], holdings: [] }).find(
    (def) => def.key === 'period'
  );

  test('the period row offers a custom range beside the presets', () => {
    expect(period?.custom?.matches('2025-04-06..2026-04-05')).toBe(true);
    expect(period?.custom?.matches('2025-04-06..')).toBe(true);
    expect(period?.custom?.matches('30')).toBe(false);
    expect(period?.custom?.matches('..')).toBe(false);
  });

  test('its chip reads as dates, not as the stored value', () => {
    expect(period?.custom?.format('2025-04-06..2026-04-05')).toBe('6 Apr 2025 – 5 Apr 2026');
    expect(period?.custom?.format('2025-04-06..')).toBe('6 Apr 2025 –');
  });

  test('a range asks the server from its first local midnight to the end of its last day', () => {
    const filters = ledgerFiltersFromView({ period: '2025-04-06..2026-04-05' });
    expect(filters).toEqual({ fromDay: '2025-04-06', toDay: '2026-04-05' });
    const input = ledgerListInput(filters, 0);
    expect(input.from).toEqual(new Date(2025, 3, 6));
    expect(input.to).toEqual(new Date(2026, 3, 6, 0, 0, 0, -1));
  });

  test('the editor is two labelled date fields', () => {
    const html = renderToStaticMarkup(
      <LedgerRangeEditor value="2025-04-06..2026-04-05" onChange={() => {}} />
    );
    expect(html).toMatch(/<label[^>]*for="ledger-range-from"[^>]*>From<\/label>/);
    expect(html).toMatch(/<label[^>]*for="ledger-range-to"[^>]*>To<\/label>/);
    expect(html).toInclude('value="2025-04-06"');
    expect(html).toInclude('value="2026-04-05"');
  });
});

describe('a ledger row looks like a Bills row (SC-1652, design review)', () => {
  const base = {
    id: 'tx1',
    occurredAt: new Date(2026, 8, 22),
    label: 'Bookshop',
    accountName: 'YNAB · Everyday Checking',
    categoryId: null,
    categoryPath: null,
    categoryColor: null,
    categorySetBy: null,
    payee: 'Bookshop',
  };
  const rowSpec = (
    row: typeof base & { quantity: string; symbol: string; tokenTypeCode: string }
  ) =>
    ledgerConfig({
      rows: [row],
      filterDefs: [],
      onSearch: () => {},
      emptyAction: null,
      peek: () => null,
      bulkActions: () => null,
    }).renderRow(row);
  const html = (node: unknown) => renderToStaticMarkup(<>{node as React.ReactNode}</>);

  test('leads with the payee initial, as Bills does', () => {
    const spec = rowSpec({ ...base, quantity: '-18', symbol: 'EUR', tokenTypeCode: 'fiat' });
    expect(html(spec.leading)).toInclude('>B<');
  });

  test('a fiat amount carries its currency symbol, not its code', () => {
    const out = html(
      rowSpec({ ...base, quantity: '-18', symbol: 'EUR', tokenTypeCode: 'fiat' }).value
    );
    expect(out).toInclude('€');
    expect(out).not.toInclude('EUR');
  });

  test('a token with no symbol keeps its code', () => {
    const out = html(
      rowSpec({ ...base, quantity: '0.015', symbol: 'BTC', tokenTypeCode: 'crypto' }).value
    );
    expect(out).toInclude('BTC');
  });
});

describe('automatic categories in the ledger (SC-1695)', () => {
  const holdings = [
    {
      id: 'h1',
      account: { name: 'Everyday Checking' },
      institution: { name: 'YNAB' },
      token: { symbol: 'EUR', typeCode: 'fiat' },
    },
  ];
  const nodes = [{ id: 'food', name: 'Food', color: null, children: [] }];
  const source = (categorySetBy: string | null) => ({
    id: 'tx1',
    occurredAt: '2026-09-22T00:00:00Z',
    description: 'CARD 4412 TESCO',
    counterparty: 'Tesco',
    quantity: '-18',
    holdingId: 'h1',
    categoryId: 'food',
    categorySetBy,
  });
  const rows = (setBy: string | null) => toLedgerRows([source(setBy)], holdings, nodes, () => 'x');
  const html = (node: unknown) => renderToStaticMarkup(<>{node as React.ReactNode}</>);
  const spec = (setBy: string | null) => {
    const row = rows(setBy)[0]!;
    return ledgerConfig({
      rows: [row],
      filterDefs: [],
      onSearch: () => {},
      emptyAction: null,
      peek: () => null,
      bulkActions: () => null,
    });
  };

  test('a row knows who set its category, and names its payee', () => {
    expect(rows('rule')[0]).toMatchObject({ categorySetBy: 'rule', payee: 'Tesco' });
    expect(rows(null)[0]?.categorySetBy).toBeNull();
  });

  test('the phone row marks a category a rule set, and not one a person set', () => {
    const marked = spec('rule');
    expect(html(marked.renderRow(rows('rule')[0]!).sublabel)).toInclude('Set automatically');
    const picked = spec('person');
    expect(html(picked.renderRow(rows('person')[0]!).sublabel)).not.toInclude('Set automatically');
  });

  test('the phone marker leads the line, so truncating a long line never hides it', () => {
    const line = html(spec('rule').renderRow(rows('rule')[0]!).sublabel);
    const marker = line.indexOf('Set automatically');
    const text = line.indexOf('Food');
    expect(marker).toBeGreaterThanOrEqual(0);
    expect(text).toBeGreaterThan(marker);
  });

  test('the category column marks it too', () => {
    const column = spec('rule').columns?.find((c) => c.key === 'category');
    expect(html(column?.render(rows('rule')[0]!))).toInclude('Set automatically');
  });

  test('a pick that spread says how far on a line of its own, never joined to the first sentence', () => {
    const t = (key: string, opts?: Record<string, unknown>) =>
      `${key}:${JSON.stringify(opts ?? {})}`;
    expect(setCategoryMessage(t as never, { updated: 1, spread: 0 }, 'Food')).toEqual({
      message: 'v3.transactions.moved:{"count":1,"name":"Food"}',
    });
    expect(setCategoryMessage(t as never, { updated: 1, spread: 3 }, 'Food')).toEqual({
      context: 'v3.transactions.moved:{"count":1,"name":"Food"}',
      message: 'v3.categories.auto.spread:{"count":3}',
    });
    expect(setCategoryMessage(t as never, { updated: 2, spread: 0 }, null)).toEqual({
      message: 'v3.transactions.cleared:{"count":2}',
    });
  });
});
