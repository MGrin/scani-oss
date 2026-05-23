import type { ParsedTransaction, ParseResult } from './types';

/**
 * Parse a QIF (Quicken Interchange Format) file into transactions.
 *
 * QIF is a simple line-based format:
 *   !Type:Bank
 *   D03/15/2024
 *   T-50.00
 *   PStore Purchase
 *   ^
 *
 * Field prefixes: D=date, T=amount, P=payee, M=memo, L=category, A=address
 * Records are separated by ^
 *
 * Note: QIF has no running balance field, so holdings extraction relies
 * on summing transactions (low confidence without a starting balance).
 */
export function parseQifStatement(content: string): ParseResult {
  const warnings: string[] = [];
  const transactions: ParsedTransaction[] = [];

  // Split into records by ^
  const records = content.split('^').filter((r) => r.trim());

  // Detect currency from header if present (not standard, but some exports include it)
  let detectedCurrency: string | undefined;

  for (const record of records) {
    const lines = record
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    let dateStr = '';
    let amount: number | null = null;
    let payee = '';
    let memo = '';

    for (const line of lines) {
      const prefix = line[0];
      const value = line.slice(1);

      switch (prefix) {
        case '!':
          // Header line, e.g., !Type:Bank
          break;
        case 'D':
          dateStr = value;
          break;
        case 'T':
          amount = Number(value.replace(/,/g, ''));
          if (Number.isNaN(amount)) amount = null;
          break;
        case 'P':
          payee = value;
          break;
        case 'M':
          memo = value;
          break;
        case 'L':
        case 'A':
        case 'N':
          // Category, Address, Check number — skip
          break;
      }
    }

    if (!dateStr || amount === null) continue;

    try {
      const date = parseQifDate(dateStr);
      transactions.push({
        date,
        description: payee || memo || 'Unknown',
        amount,
        currency: detectedCurrency || '',
      });
    } catch {
      warnings.push(`Could not parse QIF date: ${dateStr}`);
    }
  }

  if (transactions.length === 0) {
    warnings.push('No transactions found in QIF file');
  } else {
    warnings.push(
      'QIF files do not include running balances. Balance is estimated from transaction sum.'
    );
  }

  return {
    transactions,
    holdings: [],
    format: 'qif',
    detectedCurrency,
    warnings,
  };
}

/**
 * Parse QIF date formats: MM/DD/YYYY, DD/MM/YYYY, MM-DD-YYYY, etc.
 * QIF dates are ambiguous — we try native parsing first, then common patterns.
 */
function parseQifDate(dateStr: string): Date {
  // Try native parsing (works for many formats)
  const native = new Date(dateStr);
  if (!Number.isNaN(native.getTime())) return native;

  // Try dd/MM/yyyy (common in UK/EU QIF exports)
  const slashMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, dayOrMonth, monthOrDay, year] = slashMatch;
    // Assume dd/MM/yyyy if first part > 12
    if (Number(dayOrMonth) > 12) {
      return new Date(`${year}-${monthOrDay!.padStart(2, '0')}-${dayOrMonth!.padStart(2, '0')}`);
    }
    // Ambiguous — assume MM/DD/YYYY (US convention)
    return new Date(`${year}-${dayOrMonth!.padStart(2, '0')}-${monthOrDay!.padStart(2, '0')}`);
  }

  throw new Error(`Cannot parse QIF date: ${dateStr}`);
}
