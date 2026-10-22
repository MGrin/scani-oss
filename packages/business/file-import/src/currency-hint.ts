/**
 * A currency a statement file names without a Currency column, for the
 * currency question to preselect (SC-1735). It is a suggestion the owner
 * confirms, never a value applied to the rows.
 *
 * `$` and `¥` are not read: each names several currencies, and preselecting
 * the wrong one is the failure this exists to stop. Two different answers in
 * one file suggest nothing.
 */

const ISO_CODES = new Set(Intl.supportedValuesOf('currency'));

/** ISO codes that are also English words a header or preamble may shout. */
const WORD_CODES = new Set(['ALL', 'TOP', 'CUP', 'MOP', 'BAM']);

/** Longest first, so `R$` is matched before anything shorter inside it. */
const SYMBOLS: Array<[string, string]> = [
  ['US$', 'USD'],
  ['AU$', 'AUD'],
  ['CA$', 'CAD'],
  ['HK$', 'HKD'],
  ['NZ$', 'NZD'],
  ['MX$', 'MXN'],
  ['R$', 'BRL'],
  ['A$', 'AUD'],
  ['C$', 'CAD'],
  ['S$', 'SGD'],
  ['zł', 'PLN'],
  ['Kč', 'CZK'],
  ['€', 'EUR'],
  ['£', 'GBP'],
  ['₹', 'INR'],
  ['₺', 'TRY'],
  ['₽', 'RUB'],
  ['₩', 'KRW'],
  ['₱', 'PHP'],
  ['₪', 'ILS'],
  ['₫', 'VND'],
  ['₴', 'UAH'],
  ['₸', 'KZT'],
  ['₦', 'NGN'],
  ['₵', 'GHS'],
];

const CODE_TOKEN = /(?<![A-Za-z])([A-Z]{3})(?![A-Za-z])/g;

function isCode(token: string): boolean {
  return ISO_CODES.has(token) && !WORD_CODES.has(token);
}

function symbolsIn(text: string): string[] {
  const found: string[] = [];
  let rest = text;
  for (const [symbol, code] of SYMBOLS) {
    if (rest.includes(symbol)) {
      found.push(code);
      rest = rest.split(symbol).join(' ');
    }
  }
  return found;
}

function codesIn(text: string): string[] {
  return [...text.matchAll(CODE_TOKEN)].map((m) => m[1]!).filter(isCode);
}

function agreed(codes: Iterable<string>): string | undefined {
  const distinct = new Set(codes);
  return distinct.size === 1 ? [...distinct][0] : undefined;
}

export interface CurrencyHintInput {
  headers: string[];
  rows: Array<Record<string, string>>;
  /** Columns the mapping reads money from: amount, credit, debit, balance. */
  amountColumns: string[];
  /** Columns the mapping reads at all; an unmapped column of one code is a hint. */
  mappedColumns: string[];
}

export function suggestStatementCurrency(input: CurrencyHintInput): string | undefined {
  const found: string[] = [];
  const amountColumns = new Set(input.amountColumns.map((c) => c.toLowerCase()));
  const mappedColumns = new Set(input.mappedColumns.map((c) => c.toLowerCase()));

  for (const header of input.headers) {
    if (!amountColumns.has(header.toLowerCase())) continue;
    found.push(...symbolsIn(header), ...codesIn(header));
  }

  for (const row of input.rows) {
    for (const [column, value] of Object.entries(row)) {
      if (!value || !amountColumns.has(column.toLowerCase())) continue;
      found.push(...symbolsIn(value), ...codesIn(value));
    }
  }

  for (const header of input.headers) {
    if (mappedColumns.has(header.toLowerCase())) continue;
    const values = input.rows.map((row) => (row[header] ?? '').trim()).filter((v) => v !== '');
    if (values.length > 0 && values.every((v) => v === values[0]) && isCode(values[0]!)) {
      found.push(values[0]!);
    }
  }

  return agreed(found);
}

const LABELLED_CODE = /^[\p{L} .]+[:\-–]\s*([A-Z]{3})$/u;

/** The cells above a sheet's header: a cell that is a code, or a label and a code. */
export function preambleCurrency(cells: string[]): string | undefined {
  const found: string[] = [];
  for (const raw of cells) {
    const cell = raw.trim();
    if (isCode(cell)) {
      found.push(cell);
      continue;
    }
    const labelled = LABELLED_CODE.exec(cell)?.[1];
    if (labelled && isCode(labelled)) found.push(labelled);
    else if (symbolsIn(cell).length === 1 && cell.length <= 3) found.push(...symbolsIn(cell));
  }
  return agreed(found);
}

/** One suggestion from two sources: either alone, the shared one, or none on a clash. */
export function agreedCurrency(...codes: Array<string | undefined>): string | undefined {
  return agreed(codes.filter((code): code is string => !!code));
}
