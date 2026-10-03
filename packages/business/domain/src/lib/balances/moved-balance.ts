import { Decimal } from '@scani/shared';

/**
 * A stored balance moved by `delta`, as the text the cache takes: a plain
 * decimal. `Decimal`'s own text turns to exponent notation below 1e-6, so a
 * dust balance would be stored, and exported, as `5e-8` (A2 D-1, exception U4).
 *
 * Every balance the system computes from a stored one and stores as a
 * holding's balance is written through here. A balance a person typed is not
 * one of them: it is stored as typed. Neither is the pair a gap answer keeps
 * in its ledger row's metadata (`BalanceGapService`), nor an APY run's total
 * (`ApplyApyPayoutsUseCase`), which is a round8 figure written as it is.
 */
export function movedBalance(balance: string, delta: Decimal): string {
  return new Decimal(balance).add(delta).toFixed();
}
