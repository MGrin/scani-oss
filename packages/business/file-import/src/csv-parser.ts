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
    return { transactions: [], holdings: [], format: 'csv', warnings: ['No data rows found'] };
  }

  // Build case-insensitive header lookup
  const headers = Object.keys(rows[0]!);
  const headerMap = new Map<string, string>(); // lowercase → original
  for (const h of headers) {
    headerMap.set(h.toLowerCase(), h);
  }
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
      // Smart auto-detect: try to match common column name patterns
      mapping = autoDetectMapping(headerMap, warnings);
      detectedTemplate = 'auto';
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
    holdings: [],
    format: 'csv',
    bankTemplate: detectedTemplate,
    detectedCurrency,
    warnings,
  };
}

/**
 * Case-insensitive column access: tries exact match first, then case-insensitive
 *
 * Values are `string` off a fresh Papa parse, but the same row comes back out
 * of `holding_transactions.raw_payload` as JSON, where a numeric cell may have
 * survived as a number. Coercing here keeps one lookup for both callers rather
 * than a second, drifting copy for the stored-payload path (SC-159).
 */
function getColumn(
  row: Record<string, unknown>,
  columnName: string | undefined
): string | undefined {
  if (!columnName) return undefined;
  const read = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : value == null ? undefined : String(value);
  // Try exact match first
  if (row[columnName] !== undefined) return read(row[columnName]);
  // Try case-insensitive
  const lower = columnName.toLowerCase();
  for (const key of Object.keys(row)) {
    if (key.toLowerCase() === lower) return read(row[key]);
  }
  return undefined;
}

/**
 * Magnitude, not a signed amount: statements state a fee as a positive charge
 * and the ingester owns the sign. A zero is normalised away — every row of a
 * Revolut export carries `0.00` in that column, and a ledger full of
 * zero-value fee rows is noise the reader has to skip past.
 */
export function normaliseStatementFee(cell: string | undefined): number | undefined {
  const raw = parseNumber(cell);
  return raw !== null && raw !== 0 ? Math.abs(raw) : undefined;
}

/** Header spellings auto-detection accepts for the fee column, in priority order. */
const FEE_COLUMN_PATTERNS = ['fee', 'fees', 'total fees', 'charge', 'commission'] as const;

/**
 * The same fee, read back out of a stored `raw_payload` long after the upload.
 *
 * Rows imported before SC-136 dropped the charge on the floor; the CSV cell
 * that carried it is still on the row, so it is recoverable without asking
 * anyone to re-upload a statement (SC-159).
 *
 * The question it answers is deliberately **"what would re-uploading this
 * statement today read?"** rather than "what did that import read" — which was
 * nothing, since dropping the fee is the defect. So a row that names a template
 * gets that template's fee column *as it stands now*, and a template naming no
 * fee column yields no fee, exactly as a re-upload would. A row with no
 * template gets the same header patterns auto-detection uses. Either way a
 * backfilled row and a re-imported one are the same row.
 */
export function statementFeeFromRawPayload(
  rawPayload: unknown,
  bankTemplate?: string | null
): number | undefined {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return undefined;
  }
  const row = rawPayload as Record<string, unknown>;

  const template = bankTemplate ? BANK_TEMPLATES[bankTemplate] : undefined;
  if (template) return normaliseStatementFee(getColumn(row, template.fee));

  const detected = FEE_COLUMN_PATTERNS.find((pattern) => getColumn(row, pattern) !== undefined);
  return normaliseStatementFee(getColumn(row, detected));
}

/**
 * Auto-detect column mapping from headers using common patterns
 */
function autoDetectMapping(headerMap: Map<string, string>, warnings: string[]): CsvColumnMapping {
  const find = (...patterns: string[]): string | undefined => {
    for (const p of patterns) {
      const match = headerMap.get(p.toLowerCase());
      if (match) return match;
    }
    return undefined;
  };

  const date = find('date', 'transaction date', 'posted date', 'booking date', 'value date') || '';
  const description =
    find('description', 'details', 'narrative', 'memo', 'reference', 'product name') || '';
  const amount = find('amount', 'transaction amount', 'sum') || '';
  const credit = find('money in', 'credit', 'deposits', 'credit amount', 'inflow');
  const debit = find('money out', 'debit', 'withdrawals', 'debit amount', 'outflow');
  const currency = find('currency', 'ccy');
  const balance = find(
    'balance',
    'running balance',
    'account balance',
    'closing balance',
    'available balance'
  );
  const fee = find(...FEE_COLUMN_PATTERNS);

  if (!date) warnings.push('Could not detect date column');
  if (!amount && !credit) warnings.push('Could not detect amount column');

  return {
    date,
    description,
    amount: amount || '',
    credit,
    debit,
    currency,
    balance,
    fee,
  };
}

/**
 * Defang CSV-injection payloads. Cells beginning with `=`, `+`, `-`, `@`,
 * tab, or CR are interpreted as formulas by Excel/Sheets when a user
 * later exports their ledger and opens it in a spreadsheet. Prefixing
 * with a single quote tells the spreadsheet to treat the cell as text;
 * it remains harmless when consumed by humans or by our own renderers,
 * which strip the prefix before display.
 */
function sanitizeCsvCell(value: string): string {
  if (value.length === 0) return value;
  const first = value.charCodeAt(0);
  // = (0x3d), + (0x2b), - (0x2d), @ (0x40), TAB (0x09), CR (0x0d)
  if (
    first === 0x3d ||
    first === 0x2b ||
    first === 0x2d ||
    first === 0x40 ||
    first === 0x09 ||
    first === 0x0d
  ) {
    return `'${value}`;
  }
  return value;
}

function parseRow(
  row: Record<string, string>,
  mapping: CsvColumnMapping
): ParsedTransaction | null {
  const dateStr = getColumn(row, mapping.date)?.trim();
  const description = sanitizeCsvCell(getColumn(row, mapping.description)?.trim() || '');

  if (!dateStr) return null;

  // Parse amount: either single amount column or credit/debit split
  let amount: number;
  if (mapping.credit && mapping.debit) {
    const credit = parseNumber(getColumn(row, mapping.credit));
    const debit = parseNumber(getColumn(row, mapping.debit));
    // Use Math.abs for debit since some banks (e.g. Monzo) put negative values in "Money Out"
    amount = (credit || 0) - Math.abs(debit || 0);
  } else {
    const rawAmount = parseNumber(getColumn(row, mapping.amount));
    if (rawAmount === null) return null;
    amount = rawAmount;
  }

  const currency = getColumn(row, mapping.currency)?.trim() || '';
  const balance = mapping.balance ? parseNumber(getColumn(row, mapping.balance)) : undefined;

  const fee = normaliseStatementFee(getColumn(row, mapping.fee));

  return {
    date: parseDate(dateStr, mapping.dateFormat),
    description,
    amount,
    currency,
    fee,
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
  // Handle US/UK thousands format (1,234 or 12,896.83 or 1,234,567.89)
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(normalized)) {
    normalized = normalized.replace(/,/g, '');
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
