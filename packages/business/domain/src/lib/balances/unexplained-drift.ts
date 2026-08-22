import Decimal from 'decimal.js';

/**
 * How much of a balance change between two observations the ledger does not
 * explain.
 *
 * ```
 * after − before − Σ transactions in (before.observedAt, after.observedAt]
 * ```
 *
 * Half-open on purpose, and it is the half-openness that has to be shared
 * rather than merely the subtraction: a transaction stamped exactly on the
 * earlier observation belongs to the interval BEFORE this one, and a copy of
 * this rule that closed the other end would double-count it at every boundary
 * while agreeing on every interval that has no transaction on its edge — i.e.
 * it would look right on almost all of the data.
 *
 * ## Why this is a function and not two implementations
 *
 * Two callers, and they must not be able to disagree:
 *
 * * `BalanceAtTimeService.driftAhead` spreads this quantity linearly across
 *   the gap so a value series ramps instead of stepping, and marks the result
 *   `interpolated` all the way through to `portfolio_value_daily`.
 * * `BalanceGapService` asks the owner what it was (SC-501).
 *
 * A queue that surfaced a gap the interpolator did not see — or worse, the
 * other way round — would ask about money that is already accounted for, or
 * silently invent a ramp nobody was ever asked to explain. Neither shows up
 * as an error; both show up as a plausible figure.
 */
export function unexplainedDrift(
  previousBalance: Decimal | string,
  balance: Decimal | string,
  transactionQuantities: ReadonlyArray<Decimal | string>
): Decimal {
  const explained = transactionQuantities.reduce<Decimal>(
    (acc, quantity) => acc.add(new Decimal(quantity)),
    new Decimal(0)
  );
  return new Decimal(balance).sub(new Decimal(previousBalance)).sub(explained);
}

/**
 * Is `next` the exact negation of `drift`?
 *
 * A drift the following interval takes straight back is a feed artefact, not
 * money — see `BALANCE_GAP_REVERSAL_REQUIRES_EXACT_NEGATION` in
 * `@scani/shared` for the production instance and the numbers.
 *
 * `Decimal.equals` rather than a tolerance, deliberately. A tolerance here
 * would suppress two genuine movements that happen to be close in size, and
 * the whole justification for suppressing anything is that the pair is
 * *exactly* equal and opposite, which real money almost never is.
 */
export function isExactReversal(drift: Decimal, next: Decimal): boolean {
  return !drift.isZero() && drift.negated().equals(next);
}
