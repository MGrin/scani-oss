import { Decimal } from '@scani/shared';
import Papa from 'papaparse';
import type { BudgetAppAccount, BudgetAppRow, SkipReason } from './ynab-register';

export type ActualRegisterParse =
  | {
      kind: 'parsed';
      /** Actual's export names no currency. */
      currencySymbol: null;
      accounts: BudgetAppAccount[];
      skipped: Array<{ line: number; reason: SkipReason }>;
    }
  | { kind: 'not-a-register'; missing: string[] };

const REQUIRED = ['Account', 'Date', 'Payee', 'Notes', 'Amount'] as const;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SPLIT_PARENT = /^\(SPLIT INTO \d+\)\s?/;
const SPLIT_PART = /^\(SPLIT \d+ OF \d+\)\s?/;
// Actual prefixes text that starts like a spreadsheet formula with an apostrophe.
const ESCAPED = /^'(?=[=+\-@\t\r])/;
const AMOUNT = /^-?\d+(\.\d+)?$/;

/**
 * Actual Budget's transaction export (an account's Export, or the older
 * `transactions-export`). Amounts are signed decimals with a dot; dates are
 * ISO. A transfer names the other account as its payee with no marker, so a
 * payee is a transfer only when an account of that name is in the same file.
 */
export function parseActualRegister(text: string): ActualRegisterParse {
  const { data, meta } = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ''), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.replace(/^﻿/, '').trim(),
  });
  const headers = new Set(meta.fields ?? []);
  const missing = REQUIRED.filter((h) => !headers.has(h));
  if (missing.length > 0) return { kind: 'not-a-register', missing };

  const accountNames = new Set(
    data.map((row) => cellOf(row.Account)).filter((name): name is string => name !== null)
  );
  const accounts = new Map<string, BudgetAppRow[]>();
  const skipped: Array<{ line: number; reason: SkipReason }> = [];
  for (const [i, row] of data.entries()) {
    const line = i + 2;
    if (Object.values(row).every((cell) => cellOf(cell) === null)) {
      skipped.push({ line, reason: 'empty-row' });
      continue;
    }
    const notes = cellOf(row.Notes);
    if (notes !== null && SPLIT_PARENT.test(notes)) {
      skipped.push({ line, reason: 'split-parent' });
      continue;
    }
    const account = cellOf(row.Account);
    if (account === null) {
      skipped.push({ line, reason: 'no-account' });
      continue;
    }
    const date = dateOf(cellOf(row.Date));
    if (date === null) {
      skipped.push({ line, reason: 'unreadable-date' });
      continue;
    }
    const amountCell = cellOf(row.Amount);
    if (amountCell === null || !AMOUNT.test(amountCell)) {
      skipped.push({ line, reason: 'unreadable-amount' });
      continue;
    }
    const amount = new Decimal(amountCell);
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
      memo: notes === null ? null : cellOf(notes.replace(SPLIT_PART, '')),
      category: categoryOf(row),
      cleared: clearedOf(row),
      flag: null,
      transferAccount:
        payee !== null && payee !== account && accountNames.has(payee) ? payee : null,
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
  const trimmed = value?.replace(ESCAPED, '').trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function categoryOf(row: Record<string, string>): string | null {
  const group = cellOf(row.Category_Group);
  const name = cellOf(row.Category);
  if (group && name) return `${group}: ${name}`;
  return name ?? group;
}

function clearedOf(row: Record<string, string>): string | null {
  const cleared = cellOf(row.Cleared);
  if (!('Reconciled' in row)) return cleared;
  if (cellOf(row.Reconciled) === 'true') return 'Reconciled';
  if (cleared === 'true') return 'Cleared';
  if (cleared === 'false') return 'Not cleared';
  return cleared;
}

function dateOf(cell: string | null): Date | null {
  const match = cell?.match(ISO_DATE);
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return date.getUTCMonth() === Number(m) - 1 && date.getUTCDate() === Number(d) ? date : null;
}
