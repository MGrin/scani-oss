import { describePaymentFormBlockers, type PaymentFormDraft } from '@/v2/lib/paymentForm';

/**
 * The recurring-payment form's submit gate, amount included.
 *
 * `describePaymentFormBlockers` is the right mechanism and stays the base — it
 * owns the vendor, the currency, the anchor date and the repeat count. What it
 * never checked is the amount, and every other field on that form defaults to
 * something valid: the currency to the reader's base currency, the anchor to
 * today, the count to "1". So the vendor was the *only* blocker a new form ever
 * reported, and picking one emptied the list entirely — the button enabled
 * itself, the "To continue:" line vanished, and a bill with no figure was
 * written (D-5 / M-11).
 *
 * A payment with no amount is not a payment the app can use. It reads as a bare
 * dash in the list and in its own peek, its detail claims a fixed amount and a
 * monthly equivalent of "Varies" in the same breath, and it is silently dropped
 * from the committed-per-month total because there is nothing to add.
 *
 * The one case where an empty amount *is* the answer is a variable payment —
 * "the real figure is set when you settle each one" is what that control means
 * — so the rule is conditional rather than blanket, and the estimate stays
 * optional there.
 *
 * Split into v3 rather than pushed into the v2 module because v2's own form is
 * not this ticket's to change; the same reasoning as `lib/manual-entry.ts`.
 */

export type PaymentKind = 'fixed' | 'variable';

export interface V3PaymentFormDraft extends PaymentFormDraft {
  /** Raw input from the amount field — `NumericFormat`'s unformatted value. */
  amount: string;
  kind: PaymentKind;
}

export function describeV3PaymentFormBlockers(draft: V3PaymentFormDraft): string[] {
  const blockers = describePaymentFormBlockers(draft);
  const amount = draft.amount.trim();
  const positive = amount.length > 0 && Number(amount) > 0;

  if (draft.kind === 'fixed' && !positive) {
    // One sentence for both the empty field and the typed zero: the second is
    // rare, and "enter the amount" in front of a "0" reads as the instruction
    // it is rather than as a quibble.
    blockers.push('enter the amount');
  } else if (draft.kind === 'variable' && amount.length > 0 && !positive) {
    // An estimate is optional, but a zero one is a claim, and it is the claim
    // that makes the row read as free.
    blockers.push('make the estimate more than zero, or clear it');
  }

  return blockers;
}

/**
 * What "repeats every N <unit>" actually means, said back to the reader.
 *
 * The field carried a fixed line — "Fortnightly is every 2 weeks, anchored on
 * the day it's due" — beside a unit control that mostly reads `Month(s)`, so
 * the helper described a frequency the adjacent control was not set to (SC-71
 * 10.5). A helper that answers the *current* setting is the one worth having;
 * a helper that explains a setting the reader did not choose is noise at best.
 *
 * The anchoring half is the part that is genuinely not obvious and it is true
 * of every unit, so it stays.
 *
 * With no unit chosen — an invoice that evidenced no cadence (SC-147) — there
 * is no frequency to describe, and "Repeats every , anchored on…" would be
 * worse than the question itself.
 */
export function describeRepeatInterval(count: string, unit: string): string {
  if (!unit) return 'One invoice never proves a cadence — say how often this bill arrives.';
  const parsed = Number.parseInt(count, 10);
  const every =
    Number.isFinite(parsed) && parsed > 1 ? `every ${parsed} ${unit}s` : `every ${unit}`;
  return `Repeats ${every}, anchored on the day it's due.`;
}
