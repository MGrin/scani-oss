import { Decimal } from '@scani/shared';
import writeXlsxFile, { type Row, type SheetData } from 'write-excel-file/browser';
import type { ExportSheet, ExportValue } from './workbook';

/**
 * XLSX, written in the browser.
 *
 * `write-excel-file/browser` rather than a heavier workbook library: it targets
 * the browser directly (its only dependency is `fflate`, the zip codec), it
 * writes real number and date cells with number formats, and it does frozen
 * headers — which is the whole list of things this export needs and nothing
 * else. `exceljs` is a Node-shaped API that pulls a stream polyfill into the
 * bundle, and SheetJS's npm build has been frozen at 0.18 since the project
 * moved distribution off the registry.
 *
 * The three things this file is actually deciding:
 *
 * 1. **A figure is a `Number` cell, or it is not written as a figure at all.**
 *    XLSX stores numbers as IEEE-754 doubles, exactly like JavaScript, so any
 *    value that does not survive `Number(...)` intact cannot be stored as a
 *    number *by the format* — not by this code. A 27-decimal token quantity is
 *    the real case. Rather than write a rounded number and let a reader believe
 *    it, `toNumberCell` checks the round-trip and falls back to a text cell
 *    holding every digit. Losing sortability on one column is a smaller lie
 *    than losing digits from a balance.
 *
 *    **A text cell is the last resort, and money must never reach it** (SC-172).
 *    A yearly bill divided by twelve arrives as a 28-digit repeating decimal;
 *    the guard fired on it exactly as written, wrote `98.33333…` as a shared
 *    string, and Excel's `SUM` then skipped the row — no error, no warning, a
 *    column that totals five of six vendors. The guard was not the defect: an
 *    unrounded money figure reaching it was. `workbook.ts` now rounds every
 *    figure to the decimals it declares, so a money cell round-trips by
 *    construction and the fallback is left for the quantities it was written
 *    for. `assertRoundTrips` states that as an invariant a test can hold.
 * 2. **Money carries a number format, not a symbol in the string.** `#,##0.00`
 *    with the currency code, so the cell displays as money, sums as money, and
 *    the formula bar shows the number.
 * 3. **The header row is frozen and bold** (`stickyRowsCount: 1`), because the
 *    first thing anyone does with an exported sheet is scroll it.
 */

/** Widths are in characters. A money column with a code in its header
 *  (`Committed (EUR, converted)`) is the widest thing here. */
const NUMERIC_COLUMN_WIDTH = 18;
const TEXT_COLUMN_WIDTH = 26;

type Cell = NonNullable<Row[number]>;

/**
 * Whether a figure survives the trip through a double intact — and so whether
 * it can be written as a number at all.
 *
 * The guard itself, named and exported. It was previously an expression buried
 * in `toNumberCell`, reachable by a test only through a whole workbook blob,
 * which is the second half of why SC-172 shipped: the only money in the fixture
 * was `73782.10`, already rounded, and the one value claiming to exercise the
 * fallback (`1e-27`) has a single significant digit and round-trips perfectly.
 * Nothing had ever failed this check in a test.
 */
export function isExactAsNumber(value: string): boolean {
  const asNumber = Number(value);
  return Number.isFinite(asNumber) && new Decimal(asNumber).equals(new Decimal(value));
}

function toNumberCell(value: ExportValue & { kind: 'number' }): Cell {
  if (!isExactAsNumber(value.value)) return { type: String, value: value.value, align: 'right' };

  return {
    type: Number,
    value: Number(value.value),
    format: numberFormat(value),
  };
}

export function numberFormat(value: ExportValue & { kind: 'number' }): string {
  const decimals = value.decimals ?? (value.style === 'money' ? 2 : 8);
  const fraction = decimals > 0 ? `.${'0'.repeat(decimals)}` : '';
  // The sheet's declared decimals, for percent too: it used to be a fixed
  // `0.00"%"`, which is the right answer only while the sheet also says two.
  if (value.style === 'percent') return `0${fraction}"%"`;
  if (value.style === 'money' && value.currency) {
    // The code rather than a symbol: `$` is four different currencies and the
    // export's own headers already name the code. A literal in the format
    // string keeps the cell a number.
    return `#,##0${fraction}" ${value.currency}"`;
  }
  return `#,##0${fraction}`;
}

function toCell(value: ExportValue): Cell | null {
  switch (value.kind) {
    case 'blank':
      return null;
    case 'text':
      return { type: String, value: value.value };
    case 'number':
      return toNumberCell(value);
    case 'date':
      // Dates go in as real `Date` cells so a spreadsheet can filter and sort
      // them by time rather than lexically. A date-only value is pinned to UTC
      // midnight — the same instant it means in the database — and displayed
      // without a time, so it cannot drift a day in the reader's zone.
      return {
        type: Date,
        value: new Date(value.withTime ? value.value : `${value.value}T00:00:00.000Z`),
        format: value.withTime ? 'yyyy-mm-dd hh:mm' : 'yyyy-mm-dd',
      };
  }
}

function toSheetData(sheet: ExportSheet): SheetData {
  const header: Row = sheet.headers.map((text, index) => ({
    type: String,
    value: text,
    fontWeight: 'bold',
    align: sheet.numericColumns[index] ? 'right' : 'left',
  }));
  return [header, ...sheet.rows.map((row): Row => row.map(toCell))];
}

export async function toXlsxBlob(sheets: readonly ExportSheet[]): Promise<Blob> {
  return writeXlsxFile(
    sheets.map((sheet) => ({
      // Excel refuses `[ ] : * ? / \` in a tab name and caps it at 31
      // characters. A surface noun never hits either, but a workbook sheet
      // named after a group label could.
      sheet: safeSheetName(sheet.name),
      data: toSheetData(sheet),
      stickyRowsCount: 1,
      columns: sheet.numericColumns.map((numeric) => ({
        width: numeric ? NUMERIC_COLUMN_WIDTH : TEXT_COLUMN_WIDTH,
      })),
    }))
  ).toBlob();
}

export function safeSheetName(name: string): string {
  const cleaned = name.replace(/[[\]:*?/\\]/g, ' ').trim();
  return (cleaned || 'Sheet').slice(0, 31);
}
