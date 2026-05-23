export { parseCsvStatement } from './csv-parser';
export { detectBankTemplate, detectFormat } from './format-detector';
export { parseIbCsvStatement } from './ib-csv-parser';
export { parseOfxStatement } from './ofx-parser';
export { parseQifStatement } from './qif-parser';
export type {
  CsvColumnMapping,
  ExtractedHolding,
  ParsedTransaction,
  ParseResult,
  StatementFormat,
} from './types';
export { BANK_TEMPLATES } from './types';

import { createComponentLogger } from '@scani/logging';
import Papa from 'papaparse';
import { parseCsvStatement } from './csv-parser';
import { detectFormat } from './format-detector';
import { parseIbCsvStatement } from './ib-csv-parser';
import { parseOfxStatement } from './ofx-parser';
import { parseQifStatement } from './qif-parser';
import type { CsvColumnMapping, ExtractedHolding, ParsedTransaction, ParseResult } from './types';

const logger = createComponentLogger('file-import');

export type AIColumnDetector = (
  headers: string[],
  sampleRows: Record<string, string>[]
) => Promise<Record<string, string> | null>;

export interface ParseStatementOptions {
  bankTemplate?: string;
  customMapping?: CsvColumnMapping;
  aiColumnDetector?: AIColumnDetector;
}

/**
 * Extract holdings (final balances per currency/asset) from parsed transactions.
 * Groups by currency and finds the last transaction with a balance for each.
 */
export function extractHoldingsFromTransactions(
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
  content: string,
  filename?: string,
  options?: ParseStatementOptions
): Promise<ParseResult> {
  const { bankTemplate, customMapping, aiColumnDetector } = options ?? {};
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
      let result = parseCsvStatement(content, bankTemplate, customMapping);

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
                result = parseCsvStatement(content, undefined, mergedMapping);
                result.warnings.push('Column mapping detected by AI');
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
      const result = parseQifStatement(content);
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
      return {
        transactions: [],
        holdings: [],
        format: 'mt940',
        warnings: ['MT940 format support coming soon. Please export as CSV or OFX instead.'],
      };
  }
}
