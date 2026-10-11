import { Decimal } from '@scani/shared';
import Papa from 'papaparse';
import { parseStatementDate } from './dates';
import type { BudgetAppAccount, BudgetAppRow, SkipReason } from './ynab-register';

export type MintRegisterParse =
  | {
      kind: 'parsed';
      /** Mint's export names no currency. */
      currencySymbol: null;
      accounts: BudgetAppAccount[];
      skipped: Array<{ line: number; reason: SkipReason }>;
    }
  | { kind: 'not-a-register'; missing: string[] };

const REQUIRED = ['Date', 'Description', 'Amount', 'Transaction Type', 'Account Name'] as const;
const AMOUNT = /^\d+(\.\d+)?$/;
const SIGN: Record<string, 1 | -1> = { credit: 1, debit: -1 };

/**
 * Mint's transaction export (Mint closed in March 2024, so only files kept from
 * before then exist). One file holds every account. Amounts are unsigned with
 * the direction in Transaction Type, and dates are US month-first. Mint marks
 * no transfer, so none is paired here.
 */
export function parseMintRegister(text: string): MintRegisterParse {
  const { data, meta } = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ''), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.replace(/^﻿/, '').trim(),
  });
  const headers = new Set(meta.fields ?? []);
  const missing = REQUIRED.filter((h) => !headers.has(h));
  if (missing.length > 0) return { kind: 'not-a-register', missing };

  const accounts = new Map<string, BudgetAppRow[]>();
  const skipped: Array<{ line: number; reason: SkipReason }> = [];
  for (const [i, row] of data.entries()) {
    const line = i + 2;
    if (Object.values(row).every((cell) => cellOf(cell) === null)) {
      skipped.push({ line, reason: 'empty-row' });
      continue;
    }
    const date = dateOf(cellOf(row.Date));
    if (date === null) {
      skipped.push({ line, reason: 'unreadable-date' });
      continue;
    }
    const digits = cellOf(row.Amount)?.replace(/,/g, '') ?? '';
    const sign = SIGN[cellOf(row['Transaction Type'])?.toLowerCase() ?? ''];
    if (!AMOUNT.test(digits) || sign === undefined) {
      skipped.push({ line, reason: 'unreadable-amount' });
      continue;
    }
    const amount = new Decimal(digits).times(sign);
    if (amount.isZero()) {
      skipped.push({ line, reason: 'zero-amount' });
      continue;
    }
    const account = cellOf(row['Account Name']);
    if (account === null) {
      skipped.push({ line, reason: 'no-account' });
      continue;
    }
    const rows = accounts.get(account) ?? [];
    rows.push({
      date,
      amount: amount.toFixed(),
      payee: cellOf(row.Description),
      memo: cellOf(row.Notes),
      category: cellOf(row.Category),
      cleared: null,
      flag: null,
      transferAccount: null,
      line,
    });
    accounts.set(account, rows);
  }

  return {
    kind: 'parsed',
    currencySymbol: null,
    accounts: [...accounts].map(([name, rows]) => ({ name, rows })),
    skipped,
  };
}

function cellOf(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function dateOf(cell: string | null): Date | null {
  if (cell === null) return null;
  try {
    return parseStatementDate(cell, 'month-first');
  } catch {
    return null;
  }
}
