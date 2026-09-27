import { Decimal } from '@scani/shared';

export type BalanceWithoutClose = { kind: 'from-rows'; balance: string } | { kind: 'unknown' };

/**
 * The balance of a holding a statement import CREATED when the file carried no
 * closing balance (SC-1324). Its imported rows are the only evidence, so their
 * signed sum is the balance, with the reader told to set the real one if the
 * account held money before.
 *
 * A negative sum is refused rather than stored: a spending-only statement
 * proves only that money left, and no bank balance goes below zero because a
 * file started mid-history. That holding stays unknown and the reader sets it.
 */
export function balanceWithoutClose(quantities: readonly string[]): BalanceWithoutClose {
  if (quantities.length === 0) return { kind: 'unknown' };
  const sum = quantities.reduce((acc, q) => acc.plus(q), new Decimal(0));
  return sum.isNegative() ? { kind: 'unknown' } : { kind: 'from-rows', balance: sum.toString() };
}
