import { type DateOrder, parseStatementDate, resolveDateOrder } from './dates';
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
export function parseQifStatement(
  content: string,
  options?: { dateOrder?: DateOrder }
): ParseResult {
  const warnings: string[] = [];
  const transactions: ParsedTransaction[] = [];
  const entries: Array<{ dateStr: string; amount: number; description: string }> = [];

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
    entries.push({ dateStr: normaliseQifDate(dateStr), amount, description: payee || memo });
  }

  const dateOrder = resolveDateOrder(
    entries.map((entry) => entry.dateStr),
    undefined,
    options?.dateOrder
  );
  if ('ambiguous' in dateOrder) {
    return {
      transactions: [],
      holdings: [],
      format: 'qif',
      warnings,
      ambiguousDateOrder: dateOrder.ambiguous,
    };
  }

  for (const entry of entries) {
    try {
      transactions.push({
        date: parseStatementDate(entry.dateStr, dateOrder.order),
        description: entry.description || 'Unknown',
        amount: entry.amount,
        currency: detectedCurrency || '',
      });
    } catch {
      warnings.push(`Could not parse QIF date: ${entry.dateStr}`);
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
 * Quicken writes `1/ 5'04`: space-padded parts and an apostrophe before the
 * year. Folded to `1/5/04` so it reads like every other numeric date.
 */
function normaliseQifDate(dateStr: string): string {
  return dateStr.replace(/\s+/g, '').replace("'", '/');
}
