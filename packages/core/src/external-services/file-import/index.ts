export { parseCsvStatement } from './csv-parser';
export { detectBankTemplate, detectFormat } from './format-detector';
export { parseOfxStatement } from './ofx-parser';
export type {
  CsvColumnMapping,
  ParsedTransaction,
  ParseResult,
  StatementFormat,
} from './types';
export { BANK_TEMPLATES } from './types';

import Papa from 'papaparse';
import { Container } from 'typedi';
import { AIService } from '../../services/AIService';
import { createComponentLogger } from '../../utils/logger';
import { parseCsvStatement } from './csv-parser';
import { detectFormat } from './format-detector';
import { parseOfxStatement } from './ofx-parser';
import type { CsvColumnMapping, ParseResult } from './types';

const logger = createComponentLogger('file-import');

/**
 * Parse a bank statement file, auto-detecting the format.
 * For CSV files, uses AI fallback when auto-detection misses key columns.
 *
 * @param content - Raw file content (string)
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

      return result;
    }
    case 'ofx':
      return parseOfxStatement(content);
    case 'mt940':
      return {
        transactions: [],
        format: 'mt940',
        warnings: ['MT940 format support coming soon. Please export as CSV or OFX instead.'],
      };
  }
}
