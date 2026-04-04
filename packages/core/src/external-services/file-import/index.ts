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

import { parseCsvStatement } from './csv-parser';
import { detectFormat } from './format-detector';
import { parseOfxStatement } from './ofx-parser';
import type { CsvColumnMapping, ParseResult } from './types';

/**
 * Parse a bank statement file, auto-detecting the format.
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
    case 'csv':
      return parseCsvStatement(content, bankTemplate, customMapping);
    case 'ofx':
      return parseOfxStatement(content);
    case 'mt940':
      // MT940 support can be added later with mt940js library
      return {
        transactions: [],
        format: 'mt940',
        warnings: ['MT940 format support coming soon. Please export as CSV or OFX instead.'],
      };
  }
}
