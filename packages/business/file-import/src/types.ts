// `ExtractedHolding` lives in `@scani/shared` so the worker's job
// returnvalue and the frontend review screen agree on the shape without
// the frontend maintaining a second copy.
export type { ExtractedHolding } from '@scani/shared';

import type { ExtractedHolding } from '@scani/shared';

/** Common transaction format normalized from any bank statement */
export interface ParsedTransaction {
  date: Date;
  description: string;
  amount: number;
  currency: string;
  /**
   * A charge the bank levied ON TOP of `amount`, as an unsigned magnitude in
   * the same currency — a Revolut ATM row is `Amount -120.00, Fee 1.50` and
   * its Balance column has moved by 121.50.
   *
   * Absent when the statement has no fee column or the cell is blank. Zero is
   * normalised away for the same reason: a `0.00` in every row of a Revolut
   * export is the column existing, not a fee being charged, and a ledger full
   * of zero-value rows is noise the user has to read past.
   */
  fee?: number;
  /** Running balance after this transaction (if available) */
  balance?: number;
  /** Original row data for debugging */
  raw?: Record<string, string>;
}

/** Result of parsing a bank statement file */
export interface ParseResult {
  transactions: ParsedTransaction[];
  /** Direct holdings extracted from the file (final balances per currency/asset) */
  holdings: ExtractedHolding[];
  /** Detected or overridden format */
  format: StatementFormat;
  /** Bank template used (for CSV) */
  bankTemplate?: string;
  /** Currency detected from the file */
  detectedCurrency?: string;
  /** Errors encountered during parsing (non-fatal) */
  warnings: string[];
}

export type StatementFormat = 'csv' | 'ofx' | 'mt940' | 'ib-csv' | 'pdf' | 'qif';

/** Column mapping for CSV files — maps logical fields to column names/indices */
export interface CsvColumnMapping {
  date: string;
  description: string;
  amount: string;
  /** If the bank splits credits/debits into separate columns */
  credit?: string;
  debit?: string;
  currency?: string;
  balance?: string;
  /**
   * A separate charge column, levied on top of `amount` in the same currency.
   * Revolut, Wise and most FX-capable accounts export one; leaving it unmapped
   * dropped the charge silently and left the derived opening balance short by
   * exactly the fees (SC-136).
   */
  fee?: string;
  /** Date format string (e.g., 'dd/MM/yyyy', 'yyyy-MM-dd') */
  dateFormat?: string;
  /** Number of header rows to skip */
  skipRows?: number;
  /** CSV delimiter (default: auto-detect) */
  delimiter?: string;
}

/** Built-in bank CSV templates */
export const BANK_TEMPLATES: Record<string, CsvColumnMapping> = {
  revolut: {
    date: 'Started Date',
    description: 'Description',
    amount: 'Amount',
    currency: 'Currency',
    balance: 'Balance',
    fee: 'Fee',
    dateFormat: 'yyyy-MM-dd HH:mm:ss',
  },
  tinkoff: {
    date: 'Дата операции',
    description: 'Описание',
    amount: 'Сумма операции',
    currency: 'Валюта операции',
    balance: 'Остаток после операции',
    dateFormat: 'dd.MM.yyyy HH:mm:ss',
  },
  sberbank: {
    date: 'Дата',
    description: 'Описание операции',
    amount: 'Сумма',
    currency: 'Валюта',
    balance: 'Остаток',
    dateFormat: 'dd.MM.yyyy',
    delimiter: ';',
  },
  alfabank: {
    date: 'Дата операции',
    description: 'Назначение платежа',
    amount: 'Сумма',
    currency: 'Валюта',
    dateFormat: 'dd.MM.yyyy',
    delimiter: ';',
  },
  wise: {
    date: 'Date',
    description: 'Description',
    amount: 'Amount',
    currency: 'Currency',
    balance: 'Running Balance',
    // Wise's statement export spells it `Total fees` — its `Exchange To
    // Amount` rows carry the conversion charge there rather than in `Amount`.
    fee: 'Total fees',
    dateFormat: 'dd-MM-yyyy',
  },
  monzo: {
    date: 'Date',
    description: 'Name',
    amount: 'Amount',
    currency: 'Currency',
    dateFormat: 'dd/MM/yyyy',
  },
  generic: {
    date: 'date',
    description: 'description',
    amount: 'amount',
    currency: 'currency',
    balance: 'balance',
    fee: 'fee',
  },
};
