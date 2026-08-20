import type { TFunction } from 'i18next';

/**
 * The recurring-payment form's submit gate, amount included.
 *
 * The vendor, currency, anchor-date and repeat-count checks are v2's mechanism
 * and stay the base; they are written out below rather than imported from
 * `v2/lib/paymentForm` because they returned hardcoded English. Five of the six
 * items in the "To continue:" list arrived untranslated while the sixth —
 * the amount, added here — was keyed, so the list rendered MIXED, which is
 * worse on one screen than being uniformly untranslated (SC-320). No scan of
 * `src/v3` could see it: the literals lived in a v2 file.
 *
 * v2's copy stays where it is and dies with that tree. `v3.*` is registered by
 * the v3 chunk alone, so one shared module calling `t()` would put raw keys in
 * front of a `/v2` reader.
 *
 * What the base never checked is the amount, and every other field on that
 * form defaults to something valid: the currency to the reader's base
 * currency, the anchor to today, the count to "1". So the vendor was the
 * *only* blocker a new form ever reported, and picking one emptied the list
 * entirely — the button enabled itself, the "To continue:" line vanished, and
 * a bill with no figure was written (D-5 / M-11).
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
 */

export type PaymentKind = 'fixed' | 'variable';

export type IntervalUnit = 'week' | 'month' | 'quarter' | 'year';
/** `''` is the unanswered cadence an invoice with no stated period leaves
 *  behind — see `buildInvoicePrefill`. Nothing else can produce it. */
export type IntervalUnitChoice = IntervalUnit | '';

export interface V3PaymentFormDraft {
  vendorId: string;
  /**
   * A vendor name carried over from an invoice, for which no `vendors`
   * row exists yet. It satisfies the vendor requirement because
   * `payments.createFromExtraction` find-or-creates the vendor by name —
   * demanding an id here would block a form the user has fully answered.
   */
  pendingVendorName?: string;
  /** A real `tokens.id`, not the text shown in the currency field. */
  currencyTokenId: string | null;
  anchorDate: string;
  /** Raw input value; non-numeric and non-positive both block. */
  intervalCount: string;
  /**
   * `''` only on the invoice path, where the document evidenced no cadence.
   * A manually created payment starts monthly and an edit loads the stored
   * unit, so neither can reach this branch. See `buildInvoicePrefill`.
   */
  intervalUnit: string;
  /** Raw input from the amount field — `NumericFormat`'s unformatted value. */
  amount: string;
  kind: PaymentKind;
}

export function describeV3PaymentFormBlockers(t: TFunction, draft: V3PaymentFormDraft): string[] {
  const blockers: string[] = [];
  if (!draft.vendorId && !draft.pendingVendorName?.trim()) {
    blockers.push(t('v3.money.blocker.chooseVendor'));
  }
  if (!draft.currencyTokenId) blockers.push(t('v3.money.blocker.pickCurrency'));
  if (!draft.anchorDate) blockers.push(t('v3.money.blocker.setAnchorDate'));
  if (!draft.intervalUnit) blockers.push(t('v3.money.blocker.chooseCadence'));

  // Digits-only rather than `parseInt`, which happily reads "1.5.2" as 1
  // and would submit a repeat count the user never typed.
  if (!/^\d+$/.test(draft.intervalCount.trim()) || Number(draft.intervalCount) <= 0) {
    blockers.push(t('v3.money.blocker.setRepeatCount'));
  }

  const amount = draft.amount.trim();
  const positive = amount.length > 0 && Number(amount) > 0;

  if (draft.kind === 'fixed' && !positive) {
    // One sentence for both the empty field and the typed zero: the second is
    // rare, and "enter the amount" in front of a "0" reads as the instruction
    // it is rather than as a quibble.
    blockers.push(t('v3.money.blocker.enterAmount'));
  } else if (draft.kind === 'variable' && amount.length > 0 && !positive) {
    // An estimate is optional, but a zero one is a claim, and it is the claim
    // that makes the row read as free.
    blockers.push(t('v3.money.blocker.estimateAboveZero'));
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
 *
 * One key PER UNIT, each with both plural forms, rather than one frame with the
 * unit interpolated into it. `every ${count} ${unit}s` is an English rule — a
 * noun pluralised by suffix and a numeral that never inflects it — and it holds
 * in none of the eight languages SC-201 is for. Russian needs three forms of
 * "месяц" chosen by the number; a frame hands the translator `{{unit}}` in the
 * nominative singular and no way to decline it.
 */
export function describeRepeatInterval(
  t: TFunction,
  count: string,
  unit: IntervalUnitChoice
): string {
  if (!unit) return t('v3.money.paymentForm.repeatNoUnit');
  const parsed = Number.parseInt(count, 10);
  // An empty, zero or unparseable count reads as one occurrence — the same
  // singular the field's own default of "1" produces.
  const plural = Number.isFinite(parsed) && parsed > 1 ? parsed : 1;
  switch (unit) {
    case 'week':
      return t('v3.money.paymentForm.repeatWeek', { count: plural });
    case 'month':
      return t('v3.money.paymentForm.repeatMonth', { count: plural });
    case 'quarter':
      return t('v3.money.paymentForm.repeatQuarter', { count: plural });
    case 'year':
      return t('v3.money.paymentForm.repeatYear', { count: plural });
  }
}
