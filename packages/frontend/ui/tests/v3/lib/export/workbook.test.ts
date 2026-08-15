import { describe, expect, it } from 'bun:test';
import {
  BLANK_CELL,
  exportConvertedMoney,
  exportCount,
  exportDate,
  exportMoney,
  exportNumber,
  exportPercent,
  exportText,
} from '../../../../src/v3/lib/export/cell';
import {
  buildSheet,
  type ExportField,
  provenanceLines,
  provenanceSheet,
} from '../../../../src/v3/lib/export/workbook';

interface Row {
  name: string;
  amount: string | null;
  currency: string;
  base?: string;
}

const NAME: ExportField<Row> = { header: 'Vendor', value: (r) => exportText(r.name) };

describe('buildSheet money columns', () => {
  it('names the currency in the header when every row shares one', () => {
    const sheet = buildSheet<Row>(
      'Vendors',
      [NAME, { header: 'Committed', value: (r) => exportMoney(r.amount, r.currency) }],
      [
        { name: 'Netflix', amount: '12.99', currency: 'EUR' },
        { name: 'Spotify', amount: '9.99', currency: 'EUR' },
      ]
    );
    expect(sheet.headers).toEqual(['Vendor', 'Committed (EUR)']);
    expect(sheet.rows[0]?.[1]).toEqual({
      kind: 'number',
      value: '12.99',
      decimals: 2,
      style: 'money',
      currency: 'EUR',
    });
  });

  it('adds a currency column when the rows disagree, so no column sums nonsense', () => {
    const sheet = buildSheet<Row>(
      'Vendors',
      [NAME, { header: 'Committed', value: (r) => exportMoney(r.amount, r.currency) }],
      [
        { name: 'Netflix', amount: '12.99', currency: 'EUR' },
        { name: 'Sky', amount: '42.50', currency: 'GBP' },
      ]
    );
    expect(sheet.headers).toEqual(['Vendor', 'Committed', 'Committed currency']);
    expect(sheet.rows[1]?.[2]).toEqual({ kind: 'text', value: 'GBP' });
  });

  it('carries the base-currency companion in a column that says it was converted', () => {
    const sheet = buildSheet<Row>(
      'Payments',
      [
        NAME,
        {
          header: 'Amount',
          value: (r) =>
            exportMoney(
              r.amount,
              r.currency,
              r.base ? { value: r.base, currency: 'EUR' } : undefined
            ),
        },
      ],
      [{ name: 'Sky', amount: '42.50', currency: 'GBP', base: '49.73' }]
    );
    // One currency across the rows, so the code goes in the header and there is
    // no currency column to add — but the converted companion still gets one.
    expect(sheet.headers).toEqual(['Vendor', 'Amount (GBP)', 'Amount (EUR, converted)']);
    expect(sheet.rows[0]?.[2]).toMatchObject({ kind: 'number', value: '49.73', currency: 'EUR' });
  });

  it('names a figure that is itself a conversion as converted', () => {
    const sheet = buildSheet<Row>(
      'Vendors',
      [NAME, { header: 'Per month', value: (r) => exportConvertedMoney(r.amount, r.currency) }],
      [{ name: 'Mixed', amount: '61.20', currency: 'EUR' }]
    );
    expect(sheet.headers).toEqual(['Vendor', 'Per month (EUR, converted)']);
  });

  it('leaves a blank cell blank rather than filling it with a zero', () => {
    const sheet = buildSheet<Row>(
      'Vendors',
      [NAME, { header: 'Committed', value: (r) => exportMoney(r.amount, r.currency) }],
      [{ name: 'Unclassified', amount: null, currency: 'EUR' }]
    );
    expect(sheet.rows[0]?.[1]).toEqual({ kind: 'blank' });
  });
});

describe('cell normalisation', () => {
  it('writes a small figure in full rather than in exponent notation', () => {
    expect(exportNumber(1e-7)).toEqual({ kind: 'number', value: '0.0000001', decimals: undefined });
  });

  it('treats the table dash as no value', () => {
    expect(exportText('—')).toEqual(BLANK_CELL);
    expect(exportText('  ')).toEqual(BLANK_CELL);
  });

  it('keeps a date-only value on its own day rather than shifting it by a zone', () => {
    expect(exportDate('2026-01-01')).toEqual({ kind: 'date', value: '2026-01-01' });
  });

  it('rejects a value that is not a figure', () => {
    expect(exportNumber('n/a')).toEqual(BLANK_CELL);
    expect(exportPercent(Number.NaN)).toEqual(BLANK_CELL);
    expect(exportMoney('12.00', null)).toEqual(BLANK_CELL);
  });
});

describe('provenanceSheet', () => {
  it('states the scope and when the file was made', () => {
    const sheet = provenanceSheet({
      subject: 'Holdings',
      scope: 'Filtered — 12 of 69 holdings',
      generatedAt: new Date('2026-08-14T10:00:00.000Z'),
      details: [{ label: 'Institution', value: 'Kraken' }],
    });
    const rows = sheet.rows.map((row) =>
      row.map((cell) => (cell.kind === 'text' ? cell.value : ''))
    );
    expect(rows).toContainEqual(['Scope', 'Filtered — 12 of 69 holdings']);
    expect(rows).toContainEqual(['Institution', 'Kraken']);
    expect(rows).toContainEqual(['Generated', '2026-08-14T10:00:00.000Z']);
  });
});

describe('hideAmounts (SC-93 item 3)', () => {
  interface Holding {
    symbol: string;
    account: string;
    balance: string;
    value: string;
    gain: string;
    holdings: number;
  }

  const ROWS: Holding[] = [
    {
      symbol: 'BTC',
      account: 'Kraken Spot',
      balance: '0.62',
      value: '33938.80',
      gain: '12.4',
      holdings: 3,
    },
  ];

  const FIELDS: ExportField<Holding>[] = [
    { header: 'Holding', value: (r) => exportText(r.symbol) },
    { header: 'Account', value: (r) => exportText(r.account) },
    { header: 'Amount', value: (r) => exportNumber(r.balance) },
    {
      header: 'Value',
      value: (r) => exportMoney(r.value, 'GBP', { value: '39500.00', currency: 'EUR' }),
    },
    { header: 'Gain / loss', value: (r) => exportPercent(r.gain) },
    { header: 'Positions', value: (r) => exportCount(r.holdings) },
  ];

  it('keeps every column when it is off', () => {
    const sheet = buildSheet('Holdings', FIELDS, ROWS);
    expect(sheet.headers).toEqual([
      'Holding',
      'Account',
      'Amount',
      'Value (GBP)',
      'Value (EUR, converted)',
      'Gain / loss (%)',
      'Positions',
    ]);
  });

  it('removes the money, the gain AND the converted column together', () => {
    // The owner's point: dropping the amount but leaving "+12.4%" or the
    // converted total still discloses it, so this is a property of the whole
    // column set.
    const sheet = buildSheet('Holdings', FIELDS, ROWS, { hideAmounts: true });
    expect(sheet.headers).toEqual(['Holding', 'Account', 'Positions']);
  });

  it('removes a raw balance too — a quantity discloses the position', () => {
    const sheet = buildSheet('Holdings', FIELDS, ROWS, { hideAmounts: true });
    expect(sheet.headers).not.toContain('Amount');
    for (const row of sheet.rows) {
      for (const cell of row) {
        expect(cell.kind === 'number' && cell.value === '0.62').toBe(false);
      }
    }
  });

  it('keeps a declared count, because a tally is not a value', () => {
    const sheet = buildSheet('Holdings', FIELDS, ROWS, { hideAmounts: true });
    expect(sheet.headers).toContain('Positions');
  });

  it('withholds a numeric column nobody classified — safe by default', () => {
    // The whole reason `count` is its own kind: an unclassified numeric column
    // is withheld, so a missed call site costs a column instead of leaking one.
    const unclassified: ExportField<Holding>[] = [
      { header: 'Holding', value: (r) => exportText(r.symbol) },
      { header: 'Mystery figure', value: (r) => exportNumber(r.holdings) },
    ];
    const sheet = buildSheet('Holdings', unclassified, ROWS, { hideAmounts: true });
    expect(sheet.headers).toEqual(['Holding']);
  });

  it('judges a column on every row, not just the first', () => {
    const sparse: ExportField<Holding>[] = [
      { header: 'Holding', value: (r) => exportText(r.symbol) },
      {
        header: 'Sometimes money',
        value: (r) => (r.symbol === 'BTC' ? BLANK_CELL : exportMoney(r.value, 'GBP')),
      },
    ];
    const rows = [ROWS[0] as Holding, { ...(ROWS[0] as Holding), symbol: 'ETH' }];
    const sheet = buildSheet('Holdings', sparse, rows, { hideAmounts: true });
    expect(sheet.headers).toEqual(['Holding']);
  });
});

describe('provenanceLines', () => {
  it('says the amounts were withheld on purpose', () => {
    const lines = provenanceLines({
      subject: 'Holdings',
      scope: 'All 19 holdings',
      generatedAt: new Date('2026-08-14T10:00:00.000Z'),
      details: [],
      rowCount: 19,
      amountsWithheld: true,
    });
    expect(lines.map((l) => l.label)).toContain('Rows');
    const withheld = lines.find((l) => l.label === 'Amounts');
    expect(withheld?.value).toContain('on purpose');
  });

  it('says nothing about amounts when they are all present', () => {
    const lines = provenanceLines({
      subject: 'Holdings',
      scope: 'All 19 holdings',
      generatedAt: new Date('2026-08-14T10:00:00.000Z'),
      details: [],
    });
    expect(lines.map((l) => l.label)).not.toContain('Amounts');
  });
});

describe('hideAmounts and empty columns', () => {
  it('drops a money column that produced only blanks, rather than leaving a hole', () => {
    // `/holdings` on an account with no cost basis: `Gain / loss` is blank on
    // every row, so it is not *detected* as a value column — and an empty
    // money-sounding column under "amounts withheld" reads as a broken
    // redaction.
    const fields: ExportField<{ name: string }>[] = [
      { header: 'Holding', value: (r) => exportText(r.name) },
      { header: 'Gain / loss', value: () => exportPercent(null) },
    ];
    const rows = [{ name: 'BTC' }, { name: 'ETH' }];
    expect(buildSheet('H', fields, rows, { hideAmounts: true }).headers).toEqual(['Holding']);
    // Left standing when nothing is being withheld: a stable column set is
    // worth more there than a tidy one.
    expect(buildSheet('H', fields, rows).headers).toEqual(['Holding', 'Gain / loss']);
  });
});
