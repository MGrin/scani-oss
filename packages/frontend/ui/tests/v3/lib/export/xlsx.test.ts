import { describe, expect, it } from 'bun:test';
import { exportMoney, exportPercent } from '../../../../src/v3/lib/export/cell';
import { exportFileName, resolveDownloadStrategy } from '../../../../src/v3/lib/export/download';
import { buildSheet, type ExportSheet } from '../../../../src/v3/lib/export/workbook';
import {
  isExactAsNumber,
  numberFormat,
  safeSheetName,
  toXlsxBlob,
} from '../../../../src/v3/lib/export/xlsx';

const SHEET: ExportSheet = {
  name: 'Holdings',
  headers: ['Holding', 'Value'],
  rows: [
    [
      { kind: 'text', value: 'BTC' },
      { kind: 'number', value: '73782.10', decimals: 2, style: 'money', currency: 'EUR' },
    ],
    [
      { kind: 'text', value: 'Société' },
      // 27 significant digits: a token quantity no IEEE-754 double can hold.
      // Not `1e-27` — that has *one* significant digit and round-trips fine,
      // which is why the fixture that used it never reached the text fallback
      // it was written to cover (SC-172).
      { kind: 'number', value: '0.123456789012345678901234567', style: 'plain' },
    ],
  ],
  numericColumns: [false, true],
};

describe('toXlsxBlob', () => {
  it('writes a real zip container', async () => {
    const blob = await toXlsxBlob([SHEET]);
    const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    // `PK` — an .xlsx is a zip, and a reader that cannot see this cannot open it.
    expect([head[0], head[1]]).toEqual([0x50, 0x4b]);
    expect(blob.size).toBeGreaterThan(0);
  });

  it('carries every sheet it was given', async () => {
    const one = await toXlsxBlob([SHEET]);
    const two = await toXlsxBlob([SHEET, { ...SHEET, name: 'About' }]);
    // Entry names sit uncompressed in the zip's central directory, so they are
    // readable without inflating anything.
    const names = (blob: Blob) =>
      blob.arrayBuffer().then((buffer) => new TextDecoder('latin1').decode(buffer));
    expect(await names(one)).not.toContain('xl/worksheets/sheet2.xml');
    expect(await names(two)).toContain('xl/worksheets/sheet2.xml');
  });
});

/**
 * SC-172. The escape hatch that demotes a figure to text is correct and stays;
 * what these hold is that **money never needs it**, whatever arithmetic produced
 * the figure. A text cell in a money column is the worst failure this export
 * has, because Excel's `SUM` skips it in silence: the column totals five of six
 * rows, looks right, and is wrong by one row's worth.
 */
describe('a money cell is always a number cell', () => {
  const throughSheet = (amount: string) =>
    buildSheet<{ amount: string }>(
      'Vendors',
      [{ header: 'Per month', value: (r) => exportMoney(r.amount, 'EUR') }],
      [{ amount }]
    ).rows[0]?.[0] as { kind: 'number'; value: string; decimals?: number };

  it('survives a repeating decimal — €1,180 a year, divided by twelve', () => {
    const cell = throughSheet('98.33333333333333333333333333');
    expect(cell.value).toBe('98.33');
    expect(isExactAsNumber(cell.value)).toBe(true);
  });

  it('survives the float tails an FX conversion leaves behind', () => {
    for (const raw of ['130017.64836043886', '3041.163666295339', '379.84959999999995']) {
      expect(isExactAsNumber(throughSheet(raw).value)).toBe(true);
    }
  });

  it('survives a sub-cent price, which is written at more decimals rather than fewer', () => {
    const cell = throughSheet('0.00007714915547392611');
    expect(cell.value).toBe('0.00007715');
    expect(isExactAsNumber(cell.value)).toBe(true);
    expect(numberFormat(cell)).toBe('#,##0.00000000" EUR"');
  });

  it('still refuses to round a quantity nobody declared a precision for', () => {
    // The case the fallback exists for: 27 significant digits, no `decimals`,
    // and no double that can hold them. Text, with every digit.
    expect(isExactAsNumber('0.123456789012345678901234567')).toBe(false);
  });
});

describe('numberFormat', () => {
  it('shows a percent at the decimals the sheet declared, not at a fixed two', () => {
    expect(numberFormat({ kind: 'number', value: '35.14', decimals: 2, style: 'percent' })).toBe(
      '0.00"%"'
    );
    expect(numberFormat({ kind: 'number', value: '35', decimals: 0, style: 'percent' })).toBe(
      '0"%"'
    );
  });

  it('carries the currency code as a literal, so the cell stays a number', () => {
    expect(
      numberFormat({ kind: 'number', value: '1.00', decimals: 2, style: 'money', currency: 'EUR' })
    ).toBe('#,##0.00" EUR"');
  });
});

describe('a percent column says so in its header (SC-174)', () => {
  it('names the unit the way a money column names its currency', () => {
    const sheet = buildSheet<{ pct: string }>(
      'Holdings',
      [{ header: 'Gain / loss', value: (r) => exportPercent(r.pct) }],
      [{ pct: '35.13513513513512' }]
    );
    expect(sheet.headers).toEqual(['Gain / loss (%)']);
    // And the figure is rounded once, in the sheet, so all three writers agree.
    expect(sheet.rows[0]?.[0]).toMatchObject({ value: '35.14', decimals: 2 });
  });
});

describe('safeSheetName', () => {
  it('strips the characters Excel refuses and caps the length', () => {
    expect(safeSheetName('Kraken / Spot')).toBe('Kraken   Spot');
    expect(safeSheetName('a'.repeat(40))).toHaveLength(31);
    expect(safeSheetName('  ')).toBe('Sheet');
  });
});

describe('resolveDownloadStrategy', () => {
  it('uses the share sheet inside an installed iOS app, where the anchor is unreliable', () => {
    expect(resolveDownloadStrategy({ standalone: true, canShareFiles: true })).toBe('share');
  });

  it('falls back to the anchor when the share sheet will not take a file', () => {
    expect(resolveDownloadStrategy({ standalone: true, canShareFiles: false })).toBe('anchor');
  });

  it('uses the anchor in a browser tab, even one that can share', () => {
    expect(resolveDownloadStrategy({ standalone: false, canShareFiles: true })).toBe('anchor');
  });
});

describe('exportFileName', () => {
  it('carries what, which subset, and when', () => {
    const date = new Date('2026-08-14T10:00:00.000Z');
    expect(exportFileName('holdings', 'csv', { date })).toBe('scani-holdings-2026-08-14.csv');
    expect(exportFileName('holdings', 'xlsx', { filtered: true, date })).toBe(
      'scani-holdings-filtered-2026-08-14.xlsx'
    );
    expect(exportFileName('recurring payments', 'csv', { date })).toBe(
      'scani-recurring-payments-2026-08-14.csv'
    );
  });
});
