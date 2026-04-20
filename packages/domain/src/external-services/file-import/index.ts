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
import { Container } from 'typedi';
import { AIService } from '../../services/AIService';
import { parseCsvStatement } from './csv-parser';
import { detectFormat } from './format-detector';
import { parseIbCsvStatement } from './ib-csv-parser';
import { parseOfxStatement } from './ofx-parser';
import { parseQifStatement } from './qif-parser';
import type { CsvColumnMapping, ExtractedHolding, ParsedTransaction, ParseResult } from './types';

const logger = createComponentLogger('file-import');

/**
 * Extract holdings (final balances per currency/asset) from parsed transactions.
 * Groups by currency and finds the last transaction with a balance for each.
 */
export function extractHoldingsFromTransactions(
  transactions: ParsedTransaction[],
  fallbackCurrency?: string
): ExtractedHolding[] {
  // Group transactions by currency
  const byCurrency = new Map<string, ParsedTransaction[]>();
  for (const tx of transactions) {
    const curr = tx.currency || fallbackCurrency || 'UNKNOWN';
    if (!byCurrency.has(curr)) byCurrency.set(curr, []);
    byCurrency.get(curr)!.push(tx);
  }

  const holdings: ExtractedHolding[] = [];
  for (const [currency, txs] of byCurrency) {
    // Find last transaction with a balance value
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
 * For CSV files, uses AI fallback when auto-detection misses key columns.
 * Returns both transactions and extracted holdings.
 *
 * @param content - Raw file content (string for text formats, base64 for PDF)
 * @param filename - Original filename (used for format detection)
 * @param bankTemplate - Optional bank template name for CSV files
 * @param customMapping - Optional custom CSV column mapping
 */
export async function parseStatement(
  content: string,
  filename?: string,
  bankTemplate?: string,
  customMapping?: CsvColumnMapping
): Promise<ParseResult> {
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
      // First pass: auto-detect columns
      let result = parseCsvStatement(content, bankTemplate, customMapping);

      // Check if balance was detected — if not, try AI
      if (!customMapping && !bankTemplate) {
        const hasBalance = result.transactions.some(
          (t) => t.balance !== null && t.balance !== undefined
        );

        if (!hasBalance && result.transactions.length > 0) {
          logger.info('No balance detected in CSV, trying AI column mapping');

          try {
            // Parse raw CSV to get headers and sample rows
            const raw = Papa.parse<Record<string, string>>(content, {
              header: true,
              skipEmptyLines: true,
              transformHeader: (h) => h.trim(),
            });

            if (raw.data.length > 0) {
              const headers = Object.keys(raw.data[0]!);
              const aiService = Container.get(AIService);
              const aiMapping = await aiService.detectCsvColumns(headers, raw.data.slice(0, 3));

              if (aiMapping && (aiMapping.balance || aiMapping.credit || aiMapping.date)) {
                // Re-parse with AI-detected mapping
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

      // Extract holdings from transactions
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
