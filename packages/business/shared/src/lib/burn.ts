import { Decimal } from '../decimal';

/**
 * The relationship between the two burn figures, in code (SC-657).
 *
 * ## They are not siblings and must never be added
 *
 * Decided by mgrin, 2026-08-26: his recurring payments are paid FROM the
 * untracked current accounts. So by the time a recurring payment happens that
 * money has **already** left the tracked perimeter — it left when he moved it
 * to the current account, and that move is already counted as a perimeter
 * exit.
 *
 *     observed  = money leaving tracked accounts   <- the real total money-out
 *     committed = the recurring book               <- funded from inside `observed`
 *
 * **`committed` is a SUBSET of `observed`.** Adding them roughly doubles the
 * burn and halves the runway.
 *
 * Two numbers side by side look like they want summing — to the reader, to
 * the next person to touch this, and to whoever eventually adds a "total
 * burn" line because the screen seems to be missing one. That is the whole
 * reason this module exists instead of a comment: `runwayDenominator` takes
 * ONE argument and there is no overload that accepts both, so the wrong
 * arithmetic has nowhere to be written.
 *
 * ## What `committed` is genuinely for
 *
 * Not a second denominator — a floor on the discretionary question. An
 * observed $43k month says nothing about how much of it he could STOP. The
 * recurring book does. That is a real second fact, and it is why showing two
 * is right even though they overlap.
 */

/**
 * The burn to divide the liquid balance by: **observed alone**.
 *
 * Deliberately unary. `liquid ÷ (observed + committed)` is the mistake this
 * signature exists to make unwritable — see the module doc.
 */
export function runwayDenominator(observedPerMonthMean: string): Decimal {
  return new Decimal(observedPerMonthMean);
}

/**
 * `committed` expressed as what it is: a share of `observed`.
 *
 * `null` when observed is zero — a share of nothing is not 0%, it is a
 * question with no answer, and rendering "0% committed" over a month he moved
 * nothing out would be a confident statement about an empty set.
 *
 * Can exceed 1. That is not a bug and must not be clamped: it means the book
 * commits more per month than actually left the perimeter, which is a real
 * and interesting state — it says the book is stale, or that he funded the
 * month from cash already outside. Clamping it to 100% would hide exactly the
 * divergence that showing two numbers exists to reveal.
 */
export function committedShareOfObserved(
  committedPerMonth: string,
  observedPerMonthMean: string
): Decimal | null {
  const observed = new Decimal(observedPerMonthMean);
  if (observed.isZero() || observed.isNegative()) return null;
  return new Decimal(committedPerMonth).dividedBy(observed);
}
