import Papa from 'papaparse';
import { detectBankTemplate } from './format-detector';
import type { CsvColumnMapping, ParsedTransaction, ParseResult } from './types';
import { BANK_TEMPLATES } from './types';

/**
 * Parse a CSV bank statement into normalized transactions.
 *
 * @param content - Raw CSV file content
 * @param templateName - Bank template name (auto-detected if omitted)
 * @param customMapping - Custom column mapping (overrides template)
 */
export function parseCsvStatement(
  content: string,
  templateName?: string,
  customMapping?: CsvColumnMapping
): ParseResult {
  const warnings: string[] = [];

  // Parse CSV
  const parseResult = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: true,
    delimiter: customMapping?.delimiter || '',
    transformHeader: (header) => header.trim(),
  });

  if (parseResult.errors.length > 0) {
    for (const err of parseResult.errors) {
      warnings.push(`Row ${err.row}: ${err.message}`);
    }
  }

  const rows = parseResult.data;
  if (rows.length === 0) {
    return { transactions: [], format: 'csv', warnings: ['No data rows found'] };
  }

  // Determine column mapping
  const headers = Object.keys(rows[0]!);
  let mapping: CsvColumnMapping;
  let detectedTemplate: string | undefined;

  if (customMapping) {
    mapping = customMapping;
  } else if (templateName && BANK_TEMPLATES[templateName]) {
    mapping = BANK_TEMPLATES[templateName]!;
    detectedTemplate = templateName;
  } else {
    // Auto-detect
    const detected = detectBankTemplate(headers);
    if (detected && BANK_TEMPLATES[detected]) {
      mapping = BANK_TEMPLATES[detected]!;
      detectedTemplate = detected;
    } else {
      mapping = BANK_TEMPLATES.generic!;
      detectedTemplate = 'generic';
      warnings.push('Could not detect bank template — using generic column names');
    }
  }

  // Parse each row
  const transactions: ParsedTransaction[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    try {
      const tx = parseRow(row, mapping);
      if (tx) transactions.push(tx);
    } catch (e) {
      warnings.push(`Row ${i + 2}: ${e instanceof Error ? e.message : 'parse error'}`);
    }
  }

  // Detect currency from data
  const currencies = new Set(transactions.map((t) => t.currency).filter(Boolean));
  const detectedCurrency = currencies.size === 1 ? [...currencies][0] : undefined;

  return {
    transactions,
    format: 'csv',
    bankTemplate: detectedTemplate,
    detectedCurrency,
    warnings,
  };
}

function parseRow(
  row: Record<string, string>,
  mapping: CsvColumnMapping
): ParsedTransaction | null {
  const dateStr = row[mapping.date]?.trim();
  const description = row[mapping.description]?.trim() || '';

  if (!dateStr) return null;

  // Parse amount: either single amount column or credit/debit split
  let amount: number;
  if (mapping.credit && mapping.debit) {
    const credit = parseNumber(row[mapping.credit]);
    const debit = parseNumber(row[mapping.debit]);
    amount = (credit || 0) - (debit || 0);
  } else {
    const rawAmount = parseNumber(row[mapping.amount]);
    if (rawAmount === null) return null;
    amount = rawAmount;
  }

  const currency = row[mapping.currency || '']?.trim() || '';
  const balance = mapping.balance ? parseNumber(row[mapping.balance]) : undefined;

  return {
    date: parseDate(dateStr, mapping.dateFormat),
    description,
    amount,
    currency,
    balance: balance ?? undefined,
    raw: row,
  };
}

/** Parse a number from various international formats */
function parseNumber(value: string | undefined): number | null {
  if (!value) return null;
  const cleaned = value.trim();
  if (!cleaned) return null;

  // Remove currency symbols and whitespace
  let normalized = cleaned.replace(/[^\d.,-]/g, '');

  // Handle European format (1.234,56 → 1234.56)
  if (/\d+\.\d{3},\d{2}$/.test(normalized)) {
    normalized = normalized.replace(/\./g, '').replace(',', '.');
  }
  // Handle comma as decimal separator (1234,56 → 1234.56)
  else if (/,\d{1,2}$/.test(normalized)) {
    normalized = normalized.replace(',', '.');
  }

  const num = Number(normalized);
  return Number.isNaN(num) ? null : num;
}

/** Parse a date string with optional format hint */
function parseDate(dateStr: string, _format?: string): Date {
  // Try native Date parsing first
  const native = new Date(dateStr);
  if (!Number.isNaN(native.getTime())) return native;

  // Try common formats
  // dd.MM.yyyy or dd.MM.yyyy HH:mm:ss (Russian banks)
  const dotMatch = dateStr.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dotMatch) {
    const [, day, month, year] = dotMatch;
    return new Date(`${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`);
  }

  // dd/MM/yyyy
  const slashMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slashMatch) {
    const [, day, month, year] = slashMatch;
    return new Date(`${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`);
  }

  // dd-MM-yyyy
  const dashMatch = dateStr.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (dashMatch) {
    const [, day, month, year] = dashMatch;
    return new Date(`${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`);
  }

  throw new Error(`Cannot parse date: ${dateStr}`);
}
