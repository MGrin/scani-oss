import { Decimal } from '@scani/shared';

/**
 * What one exported cell *is*, before anything decides how to write it.
 *
 * The whole export path hangs off this type, and the reason it is a tagged
 * union rather than a string is the one requirement a spreadsheet export cannot
 * fudge: **a figure must leave this app as a figure**. A column of
 * `"€1,234.56"` opens in Excel as a column of text — unsummable, unsortable,
 * and silently wrong the moment anyone drags it into a formula. So a surface
 * declares what a cell *means* and the writers decide the notation:
 *
 * - CSV writes a `money` cell as a bare `1234.56`, with the currency named in
 *   the header or in a companion column. Never a symbol, never a thousands
 *   separator, never a localised decimal comma — see `csv.ts`.
 * - XLSX writes it as a real number carrying a currency number-format, so the
 *   reader sees `€1,234.56` in the cell and a number in the formula bar.
 *
 * Money and quantities arrive as **decimal strings**, never as `number`.
 * Everything upstream of here — the DB's `numeric` columns, the tRPC DTOs, the
 * `Decimal.js` instance in `@scani/shared` — is exact, and parsing to a float
 * at the last step to write a spreadsheet would be the only lossy hop in the
 * chain. `toExportNumber` in `xlsx.ts` is where a value is allowed to become a
 * `number`, and only after checking it round-trips.
 */

/** A money cell's base-currency companion — SC-60's conversion, carried out.
 *
 *  The screen shows `£42.50 / ≈ €49.73`; an export that carried only one of
 *  those is either missing the figure the reader recognises or missing the one
 *  they can add up. Both go in the file, in two columns, and the converted
 *  column's header says it was converted. */
export interface ExportMoneyBase {
  value: string;
  currency: string;
  /** When the rate was struck. Reported once on the workbook's About sheet
   *  rather than per row — a rate date repeated down 200 rows is noise, and it
   *  is the same rate for all of them. */
  asOf?: string;
}

export type ExportCell =
  /** No value — not zero. A blank stays blank in both formats, because `0` in a
   *  money column is a claim that nothing was spent rather than that nothing is
   *  known. */
  | { kind: 'blank' }
  | { kind: 'text'; value: string }
  /** A plain quantity — a token balance, a unit price's operand, anything
   *  measured rather than tallied. **Withheld by "Hide amounts"**: `0.62` in a
   *  BTC row discloses the position as surely as the figure beside it, and one
   *  price lookup turns it into money. */
  | { kind: 'number'; value: string; decimals?: number }
  /**
   * A tally of *things*, not of value — 12 holdings, 3 payments, 4,096 bytes.
   *
   * A separate kind from `number` for one reason, and it is the whole design of
   * SC-93's hide-amounts option: that option has to be **safe by default**. If
   * the rule were "hide the columns that look monetary", every column anyone
   * forgets to classify leaks. Inverted, it cannot: everything numeric is
   * withheld unless it was explicitly declared a count, so the failure mode of
   * a missed call site is a file with one column fewer, never a file that
   * discloses what the reader thought they had removed.
   */
  | { kind: 'count'; value: string }
  /** `converted` marks a figure that is *already* the result of a
   *  base-currency conversion — a multi-currency total summed through SC-60's
   *  rates. It carries no companion because there is no single native amount to
   *  put beside it; what it needs is for its column to say so, which
   *  `workbook.ts` does by naming the header `… (EUR, converted)`. */
  | {
      kind: 'money';
      value: string;
      currency: string;
      base?: ExportMoneyBase;
      converted?: boolean;
    }
  /** A ratio already expressed in percent — `12.5` means 12.5%. */
  | { kind: 'percent'; value: string }
  /** `YYYY-MM-DD`. */
  | { kind: 'date'; value: string }
  /** ISO 8601 instant. */
  | { kind: 'datetime'; value: string };

export const BLANK_CELL: ExportCell = { kind: 'blank' };

/** A text cell, or blank when there is nothing to say. `—` is the em dash the
 *  tables use for "none", and it is a rendering convention rather than data:
 *  exporting it would put a dash where a spreadsheet expects an empty cell. */
export function exportText(value: string | null | undefined): ExportCell {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === '—') return BLANK_CELL;
  return { kind: 'text', value: trimmed };
}

/** A tally — see the `count` kind. Never money, never a balance. */
export function exportCount(value: string | number | null | undefined): ExportCell {
  const normalized = normalizeDecimal(value);
  return normalized === null ? BLANK_CELL : { kind: 'count', value: normalized };
}

export function exportNumber(
  value: string | number | null | undefined,
  decimals?: number
): ExportCell {
  const normalized = normalizeDecimal(value);
  return normalized === null ? BLANK_CELL : { kind: 'number', value: normalized, decimals };
}

export function exportMoney(
  value: string | number | null | undefined,
  currency: string | null | undefined,
  base?: ExportMoneyBase
): ExportCell {
  const normalized = normalizeDecimal(value);
  if (normalized === null || !currency) return BLANK_CELL;
  return { kind: 'money', value: normalized, currency, base };
}

/** A figure that is already a base-currency conversion of one or more other
 *  currencies — see the `converted` flag above. */
export function exportConvertedMoney(
  value: string | number | null | undefined,
  currency: string | null | undefined
): ExportCell {
  const cell = exportMoney(value, currency);
  return cell.kind === 'money' ? { ...cell, converted: true } : cell;
}

export function exportPercent(value: string | number | null | undefined): ExportCell {
  const normalized = normalizeDecimal(value);
  return normalized === null ? BLANK_CELL : { kind: 'percent', value: normalized };
}

/** A date cell from anything the API hands back — a `Date`, an ISO instant, or
 *  a bare `YYYY-MM-DD`. The last of those is sliced rather than parsed: `new
 *  Date('2026-01-01')` is midnight **UTC**, which in any negative-offset time
 *  zone is the 31st of December, and a statement dated a day early is the kind
 *  of defect nobody finds until an accountant does. */
export function exportDate(value: Date | string | null | undefined): ExportCell {
  const iso = toIso(value);
  return iso === null ? BLANK_CELL : { kind: 'date', value: iso.slice(0, 10) };
}

export function exportDateTime(value: Date | string | null | undefined): ExportCell {
  const iso = toIso(value);
  return iso === null ? BLANK_CELL : { kind: 'datetime', value: iso };
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return `${trimmed}T00:00:00.000Z`;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * A decimal string with no exponent and no surprises, or `null` when the input
 * is not a figure.
 *
 * `Decimal` rather than `String(value)` for one reason: a `number` that arrives
 * as `1e-7` stringifies to `"1e-7"`, and `1e-7` in a CSV cell is text to some
 * parsers and a formula to none. `toFixed()` on a `Decimal` is the
 * exponent-free form, and `Decimal` is the project-configured instance so the
 * precision matches every other figure the app computes.
 */
function normalizeDecimal(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return new Decimal(value).toFixed();
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const decimal = new Decimal(trimmed);
    return decimal.isFinite() ? decimal.toFixed() : null;
  } catch {
    return null;
  }
}
