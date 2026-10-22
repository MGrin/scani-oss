export type { BudgetAppRegisterParse } from './budget-app-register';
export { parseBudgetAppRegister } from './budget-app-register';
export { statementFeeFromRawPayload } from './csv-parser';
export type { SpreadsheetRefusalReason } from './spreadsheet';
export { statementPayee } from './statement-payee';
export type {
  ParsedTransaction,
  ParseResult,
} from './types';
export type { BudgetAppAccount, BudgetAppRow, SkipReason } from './ynab-register';

import { createComponentLogger } from '@scani/logging';
import { AI_COLUMN_MAPPING_WARNING } from '@scani/shared';
import Papa from 'papaparse';
import { parseCamt053Statement } from './camt053-parser';
import { parseCsvStatement } from './csv-parser';
import { agreedCurrency, preambleCurrency } from './currency-hint';
import type { DateOrder } from './dates';
import { detectFormat } from './format-detector';
import { parseIbCsvStatement } from './ib-csv-parser';
import { parseMt940Statement } from './mt940-parser';
import { parseOfxStatement } from './ofx-parser';
import { parseQifStatement } from './qif-parser';
import {
  isSpreadsheetBinary,
  readSpreadsheetTable,
  SpreadsheetRefusal,
  type SpreadsheetTable,
  sniffSpreadsheet,
} from './spreadsheet';
import type { CsvColumnMapping, ExtractedHolding, ParsedTransaction, ParseResult } from './types';

const logger = createComponentLogger('file-import');

type AIColumnDetector = (
  headers: string[],
  sampleRows: Record<string, string>[]
) => Promise<Record<string, string> | null>;

export interface ParseStatementOptions {
  bankTemplate?: string;
  customMapping?: CsvColumnMapping;
  aiColumnDetector?: AIColumnDetector;
  /** The user's answer to an earlier parse's `ambiguousDateOrder`. */
  dateOrder?: DateOrder;
}

/**
 * Extract holdings (final balances per currency/asset) from parsed transactions.
 * Groups by currency and finds the last transaction with a balance for each.
 */
function extractHoldingsFromTransactions(
  transactions: ParsedTransaction[],
  fallbackCurrency?: string
): ExtractedHolding[] {
  const byCurrency = new Map<string, ParsedTransaction[]>();
  for (const tx of transactions) {
    const curr = tx.currency || fallbackCurrency || 'UNKNOWN';
    if (!byCurrency.has(curr)) byCurrency.set(curr, []);
    byCurrency.get(curr)!.push(tx);
  }

  const holdings: ExtractedHolding[] = [];
  for (const [currency, txs] of byCurrency) {
    const withBalance = txs.filter((t) => t.balance != null);
    if (withBalance.length > 0) {
      const last = withBalance[withBalance.length - 1]!;
      holdings.push({
        symbol: currency,
        balance: String(last.balance),
        confidence: 1.0,
        notes: `Last balance from ${txs.length} transactions`,
      });
    }
  }
  return holdings;
}

/**
 * Parse a bank statement file, auto-detecting the format.
 * For CSV files, an optional `aiColumnDetector` callback is consulted as a
 * fallback when auto-detection misses key columns. The callback is owned
 * by the caller so this package stays free of any AI / DI dependency.
 */
export async function parseStatement(
  content: string | Uint8Array,
  filename?: string,
  options?: ParseStatementOptions
): Promise<ParseResult> {
  if (typeof content !== 'string') {
    if (isSpreadsheetBinary(content) || /\.xlsx?$/i.test(filename ?? '')) {
      return parseSpreadsheet(content, options);
    }
    // `ignoreBOM` keeps a BOM in the text, as `Buffer#toString` did before bytes came here.
    content = new TextDecoder('utf-8', { ignoreBOM: true }).decode(content);
  }
  const { bankTemplate, customMapping, aiColumnDetector, dateOrder } = options ?? {};
  const format = detectFormat(content, filename);

  if (!format) {
    return {
      transactions: [],
      holdings: [],
      format: 'csv',
      warnings: ['Could not detect file format. Please specify the format manually.'],
    };
  }

  switch (format) {
    case 'csv': {
      let result = parseCsvStatement(content, bankTemplate, customMapping, { dateOrder });

      if (!customMapping && !bankTemplate && aiColumnDetector) {
        const hasBalance = result.transactions.some(
          (t) => t.balance !== null && t.balance !== undefined
        );

        if (!hasBalance && result.transactions.length > 0) {
          logger.info('No balance detected in CSV, trying AI column mapping');

          try {
            const raw = Papa.parse<Record<string, string>>(content, {
              header: true,
              skipEmptyLines: true,
              transformHeader: (h) => h.trim(),
            });

            if (raw.data.length > 0) {
              const headers = Object.keys(raw.data[0]!);
              const aiMapping = await aiColumnDetector(headers, raw.data.slice(0, 3));

              if (aiMapping && (aiMapping.balance || aiMapping.credit || aiMapping.date)) {
                const mergedMapping: CsvColumnMapping = {
                  date: aiMapping.date || '',
                  description: aiMapping.description || '',
                  amount: aiMapping.amount || '',
                  credit: aiMapping.credit || undefined,
                  debit: aiMapping.debit || undefined,
                  currency: aiMapping.currency || undefined,
                  balance: aiMapping.balance || undefined,
                };
                result = parseCsvStatement(content, undefined, mergedMapping, { dateOrder });
                result.warnings.push(AI_COLUMN_MAPPING_WARNING);
                logger.info({ aiMapping }, 'Successfully re-parsed CSV with AI column mapping');
              }
            }
          } catch (error) {
            logger.warn({ error }, 'AI CSV column detection failed, using auto-detect result');
          }
        }
      }

      result.holdings = extractHoldingsFromTransactions(
        result.transactions,
        result.detectedCurrency
      );

      return result;
    }

    case 'ib-csv':
      return parseIbCsvStatement(content);

    case 'ofx': {
      const result = await parseOfxStatement(content);
      result.holdings = extractHoldingsFromTransactions(
        result.transactions,
        result.detectedCurrency
      );
      return result;
    }

    case 'qif': {
      const result = parseQifStatement(content, { dateOrder });
      result.holdings = extractHoldingsFromTransactions(
        result.transactions,
        result.detectedCurrency
      );
      return result;
    }

    case 'pdf':
      return {
        transactions: [],
        holdings: [],
        format: 'pdf',
        warnings: [
          'PDF files require AI vision processing. This will be handled by the upload pipeline.',
        ],
      };

    case 'mt940':
      return parseMt940Statement(content);

    case 'camt053':
      return parseCamt053Statement(content);

    case 'xlsx':
    case 'xls':
      return parseSpreadsheet(new TextEncoder().encode(content), options);
  }
}

/**
 * A sheet becomes CSV text and takes the CSV path, so header detection, the AI
 * fallback and the owner's column mapping are the ones a CSV gets (SC-1734).
 */
async function parseSpreadsheet(
  bytes: Uint8Array,
  options?: ParseStatementOptions
): Promise<ParseResult> {
  const format = sniffSpreadsheet(bytes) === 'xlsx' ? 'xlsx' : 'xls';
  let table: SpreadsheetTable;
  try {
    table = await readSpreadsheetTable(bytes);
  } catch (error) {
    if (!(error instanceof SpreadsheetRefusal)) throw error;
    return { transactions: [], holdings: [], format, warnings: [], refusal: error.reason };
  }
  const result = await parseStatement(Papa.unparse(table.rows), 'import.csv', options);
  result.format = format;
  if (result.transactions.length > 0 && !result.detectedCurrency) {
    result.suggestedCurrency = agreedCurrency(
      result.suggestedCurrency,
      preambleCurrency(table.preamble)
    );
  }
  return result;
}
