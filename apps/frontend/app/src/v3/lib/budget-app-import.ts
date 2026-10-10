/**
 * The budget app import screen's rules (SC-1649): the currency to suggest for
 * a register's symbol, the default target for each of its accounts, and what
 * still stops the import.
 */
export type BudgetAppTarget =
  | { kind: 'new'; typeCode: string }
  | { kind: 'existing'; accountId: string }
  | { kind: 'skip' };

export interface BudgetAppMapping {
  name: string;
  rows: number;
  target: BudgetAppTarget;
}

const DOLLARS = new Set(['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD']);
const KRONER = new Set(['SEK', 'NOK', 'DKK', 'ISK']);

const BY_SYMBOL: Record<string, string> = {
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
  '₹': 'INR',
  '₩': 'KRW',
  '₺': 'TRY',
  '₪': 'ILS',
  '₽': 'RUB',
  zł: 'PLN',
  R$: 'BRL',
  C$: 'CAD',
  CA$: 'CAD',
  A$: 'AUD',
  AU$: 'AUD',
  NZ$: 'NZD',
  S$: 'SGD',
  HK$: 'HKD',
  US$: 'USD',
  CHF: 'CHF',
};

/**
 * The ISO code to offer for the file's symbol. A bare `$` or `kr` names a
 * family, so the person's own base currency wins when it is in that family.
 * The person confirms the code either way; this is only the first guess.
 */
export function suggestCurrency(symbol: string | null, baseCode: string): string {
  if (symbol === null) return baseCode;
  if (symbol === '$') return DOLLARS.has(baseCode) ? baseCode : 'USD';
  if (symbol.toLowerCase() === 'kr') return KRONER.has(baseCode) ? baseCode : 'SEK';
  return BY_SYMBOL[symbol] ?? baseCode;
}

/** Every account becomes a new one by default (ruling Q4): nothing lands where it was not asked to. */
export function defaultMapping(
  accounts: ReadonlyArray<{ name: string; rows: readonly unknown[] }>
): BudgetAppMapping[] {
  return accounts.map((account) => ({
    name: account.name,
    rows: account.rows.length,
    target: { kind: 'new', typeCode: 'checking' },
  }));
}

/** Rows the import leaves out. A split's total line is not one: its parts are imported. */
export function rowsLost(skipped: ReadonlyArray<{ reason: string }>): number {
  return skipped.filter((row) => row.reason !== 'split-parent').length;
}

export type BudgetAppBlocker = 'no-account' | 'no-currency' | 'same-target';

export function mappingBlockers(
  mapping: readonly BudgetAppMapping[],
  currency: string
): BudgetAppBlocker[] {
  const blockers: BudgetAppBlocker[] = [];
  if (mapping.every((m) => m.target.kind === 'skip')) blockers.push('no-account');
  if (!/^[A-Za-z]{3}$/.test(currency.trim())) blockers.push('no-currency');
  const existing = mapping.flatMap((m) =>
    m.target.kind === 'existing' ? [m.target.accountId] : []
  );
  if (new Set(existing).size !== existing.length) blockers.push('same-target');
  return blockers;
}

/** One select carries every choice, so each target is a single option value. */
export function targetValue(target: BudgetAppTarget): string {
  if (target.kind === 'new') return `new:${target.typeCode}`;
  if (target.kind === 'existing') return `existing:${target.accountId}`;
  return 'skip';
}

export function targetFrom(value: string): BudgetAppTarget {
  if (value.startsWith('new:')) return { kind: 'new', typeCode: value.slice(4) };
  if (value.startsWith('existing:')) return { kind: 'existing', accountId: value.slice(9) };
  return { kind: 'skip' };
}
