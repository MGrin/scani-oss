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

/**
 * How many whole months the liquid balance lasts at the observed rate.
 *
 * `null` when nothing left the perimeter across the window. `liquid ÷ 0` is
 * `Infinity`, and an infinite runway on the one screen the owner scans is the
 * most flattering possible way to be wrong — so the caller gets "this window
 * cannot answer" and has to decide what to say, rather than a number.
 *
 * Lives here rather than in either surface because BOTH the home line and the
 * forecast page answer with it, and SC-661 is what happens when two surfaces
 * compute the same question in two places: they drifted until they reached
 * opposite conclusions about the same account on the same instant.
 */
export function observedRunwayMonths(
  liquidAmount: string,
  observedPerMonthMean: string
): number | null {
  const perMonth = runwayDenominator(observedPerMonthMean);
  if (perMonth.lessThanOrEqualTo(0)) return null;
  return new Decimal(liquidAmount).dividedBy(perMonth).floor().toNumber();
}

export interface ObservedAffordability {
  /** Whole months of runway before the purchase. */
  monthsBefore: number;
  /** Whole months of runway after it. */
  monthsAfter: number;
  /** What it costs, in months. Always statable — see the doc below. */
  monthsLost: number;
  /** Liquid minus the purchase, in base currency. Negative means he cannot. */
  remaining: Decimal;
  /** The purchase is smaller than the liquid balance. */
  affordable: boolean;
}

/**
 * "Can I afford X", answered against observed burn (SC-661, mgrin's call).
 *
 * ## What this gives up, deliberately
 *
 * The committed walk knew WHEN. It inserted the one-off into a dated bucket
 * and could say the balance dips in March, because the recurring book carries
 * real dates. Observed burn is a mean over six complete months — it has no
 * schedule, so this cannot tell a purchase in March from one in September.
 * **That is a real loss and the PR says so out loud.**
 *
 * ## What it buys, which is why the trade was made
 *
 * `affordability()` returns `monthsLost: null` unless BOTH walks run out
 * inside the twelve-month window. On mgrin's real book the committed
 * projection nets +$10,***REMOVED*** a month, so neither walk ever runs out and the
 * panel could only ever answer "affordable" — whatever he typed into it. A
 * control that cannot return a second answer is not a control.
 *
 * Here `monthsLost` is `amount ÷ observed` and is always a number. The panel
 * can finally cost a purchase.
 */
export function observedAffordability(
  liquidAmount: string,
  observedPerMonthMean: string,
  outflowInBase: string
): ObservedAffordability | null {
  const perMonth = runwayDenominator(observedPerMonthMean);
  if (perMonth.lessThanOrEqualTo(0)) return null;

  const liquid = new Decimal(liquidAmount);
  const remaining = liquid.minus(outflowInBase);
  const monthsBefore = liquid.dividedBy(perMonth).floor().toNumber();
  // A purchase larger than the balance leaves no runway at all. Flooring a
  // negative would report -1 months, which reads as a quantity rather than as
  // "there is nothing left".
  const monthsAfter = remaining.isNegative() ? 0 : remaining.dividedBy(perMonth).floor().toNumber();

  return {
    monthsBefore,
    monthsAfter,
    monthsLost: monthsBefore - monthsAfter,
    remaining,
    affordable: !remaining.isNegative(),
  };
}
