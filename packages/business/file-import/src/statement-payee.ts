const MONTHS = new Set([
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'SEPT',
  'OCT',
  'NOV',
  'DEC',
  'JANUARY',
  'FEBRUARY',
  'MARCH',
  'APRIL',
  'JUNE',
  'JULY',
  'AUGUST',
  'SEPTEMBER',
  'OCTOBER',
  'NOVEMBER',
  'DECEMBER',
]);

const REFERENCE_WORDS = new Set(['REF', 'REF.', 'REFERENCE']);

const CURRENCY_CODES = new Set([
  'EUR',
  'GBP',
  'USD',
  'CHF',
  'JPY',
  'CAD',
  'AUD',
  'SEK',
  'NOK',
  'DKK',
  'PLN',
]);

const LEADING_PHRASES: readonly (readonly string[])[] = [
  ['CARD', 'PAYMENT', 'TO'],
  ['CARD', 'PAYMENT'],
  ['DIRECT', 'DEBIT', 'TO'],
  ['DIRECT', 'DEBIT'],
  ['STANDING', 'ORDER', 'TO'],
  ['STANDING', 'ORDER'],
  ['FASTER', 'PAYMENT', 'TO'],
  ['FASTER', 'PAYMENT'],
  ['BILL', 'PAYMENT', 'TO'],
  ['PAYMENT', 'TO'],
  ['POS'],
  ['CONTACTLESS'],
];

const TRAILING_CONNECTORS = new Set(['ON', 'AT', 'TO', 'FROM']);

// A description made only of these names the bank's mechanism, not a payee.
// Kept as a counterparty it would become a rule key shared by every card
// payment or ATM withdrawal the user has, so one answer would silently
// classify rows that have nothing in common (SC-1325).
const BANK_WORDING = new Set([
  'ATM',
  'BANK',
  'CARD',
  'CASH',
  'CHARGE',
  'CHARGES',
  'CONTACTLESS',
  'CREDIT',
  'DEBIT',
  'DEPOSIT',
  'DIRECT',
  'FASTER',
  'FEE',
  'FEES',
  'INTEREST',
  'ONLINE',
  'ORDER',
  'PAYMENT',
  'PAYMENTS',
  'POS',
  'PURCHASE',
  'STANDING',
  'TRANSFER',
  'TRANSFERS',
  'WITHDRAWAL',
  'WITHDRAWALS',
  ...TRAILING_CONNECTORS,
]);

/**
 * The payee a statement line names, or null when it names nobody.
 *
 * Dates, amounts, card and reference numbers vary from month to month on a
 * payment to the same payee, so they are dropped: "RENT SEP 2026 #4411" and
 * "RENT OCT" must give one value for one per-payee rule to cover both. The
 * result feeds a stored column that re-uploads overwrite and suggestion
 * dismissals key on, so it must stay deterministic.
 */
export function statementPayee(description: string | undefined): string | null {
  const kept: string[] = [];
  let previousWasNumber = false;
  for (const token of (description ?? '').split(/\s+/)) {
    const upper = token.toUpperCase();
    const isNumber = /\d/.test(token);
    const isNoise =
      isNumber ||
      !/[\p{L}]/u.test(token) ||
      MONTHS.has(upper) ||
      REFERENCE_WORDS.has(upper) ||
      (previousWasNumber && CURRENCY_CODES.has(upper));
    previousWasNumber = isNumber;
    if (!isNoise) kept.push(token);
  }

  const upper = kept.map((t) => t.toUpperCase());
  const phrase = LEADING_PHRASES.find((p) => p.every((word, i) => upper[i] === word));
  let start = phrase?.length ?? 0;
  let end = kept.length;
  while (end > start && TRAILING_CONNECTORS.has(upper[end - 1] ?? '')) end -= 1;
  while (start < end && TRAILING_CONNECTORS.has(upper[start] ?? '')) start += 1;

  const payee = upper.slice(start, end);
  if (payee.length === 0 || payee.every((t) => BANK_WORDING.has(t))) return null;
  return kept.slice(start, end).join(' ');
}
