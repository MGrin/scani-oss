import { Decimal } from '@scani/shared';
import Papa from 'papaparse';
import {
  type AmbiguousDateOrder,
  type DateOrder,
  parseStatementDate,
  resolveDateOrder,
} from './dates';

/** One register row, signed with money in positive. */
export interface BudgetAppRow {
  date: Date;
  amount: string;
  payee: string | null;
  memo: string | null;
  category: string | null;
  cleared: string | null;
  flag: string | null;
  /** The other account of a transfer, as the file names it. */
  transferAccount: string | null;
  /** 1-based line in the file, the header being line 1. */
  line: number;
}

export interface BudgetAppAccount {
  name: string;
  rows: BudgetAppRow[];
}

export type SkipReason =
  | 'empty-row'
  | 'no-account'
  | 'unreadable-date'
  | 'unreadable-amount'
  | 'zero-amount'
  /** Actual's split header: its parts follow as their own rows and carry the money. */
  | 'split-parent';

export type YnabRegisterParse =
  | {
      kind: 'parsed';
      /** The symbol the amounts carry ("$", "€"), or null when they carry none (YNAB4). */
      currencySymbol: string | null;
      accounts: BudgetAppAccount[];
      skipped: Array<{ line: number; reason: SkipReason }>;
    }
  | { kind: 'ambiguous-dates'; dates: AmbiguousDateOrder }
  | { kind: 'not-a-register'; missing: string[] }
  | { kind: 'mixed-decimal-separators' };

const REQUIRED = ['Account', 'Date', 'Payee', 'Memo', 'Outflow', 'Inflow'] as const;
const YEAR_FIRST = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/;
const TRANSFER = /^Transfer : (.+)$/;

/**
 * YNAB's register export (web "Export Plan", or YNAB4). Outflow and Inflow are
 * unsigned and carry the plan's currency symbol; a decimal-comma plan exports
 * TSV with day-first dates. The decimal separator is a property of the file,
 * read from every amount at once, so `1.234` means one thing throughout.
 */
export function parseYnabRegister(text: string, dateOrder?: DateOrder): YnabRegisterParse {
  const { data, meta } = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ''), {
    header: true,
    skipEmptyLines: true,
    delimiter: '',
    transformHeader: (h) => h.replace(/^﻿/, '').trim(),
  });
  const headers = new Set(meta.fields ?? []);
  const missing = REQUIRED.filter((h) => !headers.has(h));
  if (missing.length > 0) return { kind: 'not-a-register', missing };

  const cells = data.flatMap((row) => [cellOf(row.Outflow), cellOf(row.Inflow)]);
  const separator = decimalSeparator(cells);
  if (separator === 'mixed') return { kind: 'mixed-decimal-separators' };

  const dates = data.map((row) => cellOf(row.Date)).filter((d): d is string => d !== null);
  const order = resolveDateOrder(
    dates.filter((d) => !YEAR_FIRST.test(d)),
    undefined,
    dateOrder
  );
  if ('ambiguous' in order) return { kind: 'ambiguous-dates', dates: order.ambiguous };

  const accounts = new Map<string, BudgetAppRow[]>();
  const skipped: Array<{ line: number; reason: SkipReason }> = [];
  for (const [i, row] of data.entries()) {
    const line = i + 2;
    if ([row.Date, row.Payee, row.Outflow, row.Inflow].every((cell) => cellOf(cell) === null)) {
      skipped.push({ line, reason: 'empty-row' });
      continue;
    }
    const account = cellOf(row.Account);
    if (account === null) {
      skipped.push({ line, reason: 'no-account' });
      continue;
    }
    const date = dateOf(cellOf(row.Date), order.order);
    if (date === null) {
      skipped.push({ line, reason: 'unreadable-date' });
      continue;
    }
    const outflow = amountOf(cellOf(row.Outflow), separator);
    const inflow = amountOf(cellOf(row.Inflow), separator);
    if (outflow === null || inflow === null) {
      skipped.push({ line, reason: 'unreadable-amount' });
      continue;
    }
    const amount = inflow.minus(outflow);
    if (amount.isZero()) {
      skipped.push({ line, reason: 'zero-amount' });
      continue;
    }
    const payee = cellOf(row.Payee);
    const rows = accounts.get(account) ?? [];
    rows.push({
      date,
      amount: amount.toFixed(),
      payee,
      memo: cellOf(row.Memo),
      category: categoryOf(row),
      cleared: cellOf(row.Cleared),
      flag: cellOf(row.Flag),
      transferAccount: payee?.match(TRANSFER)?.[1]?.trim() ?? null,
      line,
    });
    accounts.set(account, rows);
  }

  return {
    kind: 'parsed',
    currencySymbol: symbolOf(cells),
    accounts: [...accounts].map(([name, rows]) => ({ name, rows })),
    skipped,
  };
}

function cellOf(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function categoryOf(row: Record<string, string>): string | null {
  const combined = cellOf(row['Category Group/Category']);
  if (combined) return combined;
  const group = cellOf(row['Category Group']) ?? cellOf(row['Master Category']);
  const name = cellOf(row['Sub Category']) ?? cellOf(row.Category);
  if (group && name) return `${group}: ${name}`;
  return name ?? group;
}

function numericPart(cell: string): string {
  return cell.replace(/[−]/g, '-').replace(/[^\d.,\-()]/g, '');
}

type Separator = '.' | ',' | null | 'mixed';

/** The decimal point every amount in the file uses; null when none has decimals. */
function decimalSeparator(cells: Array<string | null>): Separator {
  let dot = false;
  let comma = false;
  for (const cell of cells) {
    if (cell === null) continue;
    const digits = numericPart(cell).replace(/[()-]/g, '');
    if (/\.\d{2}$/.test(digits)) dot = true;
    if (/,\d{2}$/.test(digits)) comma = true;
  }
  if (dot && comma) return 'mixed';
  return dot ? '.' : comma ? ',' : null;
}

function amountOf(cell: string | null, separator: Separator): Decimal | null {
  if (cell === null) return new Decimal(0);
  let digits = numericPart(cell);
  const negative = digits.includes('-') || /^\(.*\)$/.test(digits);
  digits = digits.replace(/[()-]/g, '');
  const grouping = separator === '.' ? /,/g : separator === ',' ? /\./g : /[.,]/g;
  digits = digits.replace(grouping, '');
  if (separator === ',') digits = digits.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(digits)) return null;
  const value = new Decimal(digits);
  return negative ? value.negated() : value;
}

function dateOf(cell: string | null, order: DateOrder | null): Date | null {
  if (cell === null) return null;
  const yearFirst = cell.match(YEAR_FIRST);
  if (yearFirst) {
    const [, y, m, d] = yearFirst;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    return date.getUTCDate() === Number(d) ? date : null;
  }
  try {
    return parseStatementDate(cell, order);
  } catch {
    return null;
  }
}

/** The symbol most amounts carry: what is left once digits and separators go. */
function symbolOf(cells: Array<string | null>): string | null {
  const counts = new Map<string, number>();
  for (const cell of cells) {
    if (cell === null) continue;
    const symbol = cell.replace(/[\d.,\-−()\s]/g, '');
    if (symbol !== '') counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [symbol, count] of counts)
    if (best === null || count > counts.get(best)!) best = symbol;
  return best;
}
