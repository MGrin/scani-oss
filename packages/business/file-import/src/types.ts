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
  },
};
