import {
  APP_LOCALE,
  APP_NUMBER_LOCALE,
  type Decimal,
  formatNumber,
  quantityDecimals,
} from '@scani/shared';
import type { ParsedTransaction, ParseResult } from './types';

const DAY_MS = 86_400_000;
/** How many lines a warning names before it counts the rest. */
const NAMED_LATE_LINES = 5;

/** A balance a statement states for a calendar day. A debit balance is negative. */
export interface StatedBalance {
  currency: string;
  amount: Decimal;
  /** The day the bank names, at midnight UTC. */
  day: Date;
}

/** One statement out of an MT940 or CAMT.053 file. */
export interface BalancedStatement {
  /** The account and currency it is for, as the file spells them. */
  account: string;
  opening?: StatedBalance;
  closing?: StatedBalance;
  transactions: ParsedTransaction[];
}

/** A calendar day at midnight UTC, or null for a date no calendar has. */
export function utcDay(year: number, month: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  const exists =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return exists ? date : null;
}

const isoDay = (day: Date) => day.toISOString().slice(0, 10);

// A warning is an English sentence written where there is no reader, so it
// takes the English tags rather than a reader's: `2 Jan 2025`, `1,605`.
const WARNING_DAY = new Intl.DateTimeFormat(APP_LOCALE, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** A figure as the result card prints the closing balance above the warning. */
const warningFigure = (figure: Decimal | number) =>
  formatNumber(typeof figure === 'number' ? figure : figure.toFixed(), {
    decimals: quantityDecimals(figure),
    locale: APP_NUMBER_LOCALE,
  });

/**
 * A closing balance already holds every line of its statement, so a line
 * dated after it would be counted twice. Such a line is ordered on the day
 * the statement closes, and never quietly: the row keeps the bank's date as
 * `raw.bankDate`, and the import says how many lines it was and names them.
 */
function orderedByClose(
  { closing, transactions }: BalancedStatement,
  warnings: string[]
): ParsedTransaction[] {
  const late = closing ? transactions.filter((tx) => tx.date > closing.day) : [];
  if (!closing || late.length === 0) return transactions;

  const named = late
    .slice(0, NAMED_LATE_LINES)
    .map((tx) => `${WARNING_DAY.format(tx.date)}, ${warningFigure(tx.amount)} ${tx.currency}`);
  const unnamed = late.length - NAMED_LATE_LINES;
  if (unnamed > 0) named.push(`and ${unnamed} more`);
  const count = late.length === 1 ? '1 line is' : `${late.length} lines are`;
  warnings.push(
    `${count} dated after the statement closed on ${WARNING_DAY.format(closing.day)}, so ${late.length === 1 ? 'it is' : 'they are'} placed on that day: ${named.join('; ')}`
  );

  return transactions.map((tx) =>
    tx.date > closing.day
      ? { ...tx, date: closing.day, raw: { ...tx.raw, bankDate: isoDay(tx.date) } }
      : tx
  );
}

/**
 * The result of a file of statements that state their own balances.
 *
 * An import goes to one account, so a file holding several is refused whole:
 * their lines would land in one ledger. A file of several statements for one
 * account closes on the latest of them, at that day's final instant.
 */
export function balancedStatementResult(
  format: 'mt940' | 'camt053',
  statements: BalancedStatement[],
  warnings: string[]
): ParseResult {
  const accounts = new Set(statements.map((statement) => statement.account));
  if (accounts.size > 1) {
    return {
      transactions: [],
      holdings: [],
      format,
      warnings: [
        `This file holds statements for ${accounts.size} accounts, so nothing was imported. Export one account per file`,
      ],
    };
  }

  for (const { opening, closing, transactions } of statements) {
    if (!opening || !closing) continue;
    const reached = transactions.reduce((sum, tx) => sum.plus(tx.amount), opening.amount);
    if (!reached.equals(closing.amount)) {
      warnings.push(
        `This statement's opening balance and lines add up to ${warningFigure(reached)} ${closing.currency}, but it states a closing balance of ${warningFigure(closing.amount)} ${closing.currency}`
      );
    }
  }

  const transactions = statements.flatMap((statement) => orderedByClose(statement, warnings));
  const closing = statements.reduce<StatedBalance | undefined>(
    (latest, statement) =>
      statement.closing && !(latest && latest.day > statement.closing.day)
        ? statement.closing
        : latest,
    undefined
  );
  const detectedCurrency =
    closing?.currency ?? statements[0]?.opening?.currency ?? transactions[0]?.currency;
  if (!closing) return { transactions, holdings: [], format, detectedCurrency, warnings };

  const balance = closing.amount.toFixed();
  return {
    transactions,
    holdings: [
      {
        symbol: closing.currency,
        balance,
        confidence: 1.0,
        notes: 'Closing balance of the statement',
      },
    ],
    positions: {
      asOf: new Date(closing.day.getTime() + DAY_MS - 1),
      cash: [{ currency: closing.currency, balance }],
      securities: [],
    },
    format,
    detectedCurrency,
    warnings,
  };
}
