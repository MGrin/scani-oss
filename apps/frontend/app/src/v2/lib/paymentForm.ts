/**
 * Submit-gating for the recurring-payment form.
 *
 * Lives outside the component because the bug it exists to prevent was
 * invisible: the currency field is a search-and-pick control, so typing
 * "USD" and moving on left the form's `currencyTokenId` null while the
 * field READ as filled. The button disabled itself and said nothing.
 *
 * Returning the reasons rather than a boolean is the point — the caller
 * can always tell the user which field is actually blocking them.
 */
export interface PaymentFormDraft {
  vendorId: string;
  /** A real `tokens.id`, not the text shown in the currency field. */
  currencyTokenId: string | null;
  anchorDate: string;
  /** Raw input value; non-numeric and non-positive both block. */
  intervalCount: string;
}

export function describePaymentFormBlockers(draft: PaymentFormDraft): string[] {
  const blockers: string[] = [];
  if (!draft.vendorId) blockers.push('choose a vendor');
  if (!draft.currencyTokenId) blockers.push('pick a currency from the list');
  if (!draft.anchorDate) blockers.push('set an anchor date');

  // Digits-only rather than `parseInt`, which happily reads "1.5.2" as 1
  // and would submit a repeat count the user never typed.
  if (!/^\d+$/.test(draft.intervalCount.trim()) || Number(draft.intervalCount) <= 0) {
    blockers.push('set a valid repeat count');
  }

  return blockers;
}
