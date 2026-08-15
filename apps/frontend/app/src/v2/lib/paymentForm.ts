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
}

export function describePaymentFormBlockers(draft: PaymentFormDraft): string[] {
  const blockers: string[] = [];
  if (!draft.vendorId && !draft.pendingVendorName?.trim()) blockers.push('choose a vendor');
  if (!draft.currencyTokenId) blockers.push('pick a currency from the list');
  if (!draft.anchorDate) blockers.push('set an anchor date');
  if (!draft.intervalUnit) blockers.push('choose how often this repeats');

  // Digits-only rather than `parseInt`, which happily reads "1.5.2" as 1
  // and would submit a repeat count the user never typed.
  if (!/^\d+$/.test(draft.intervalCount.trim()) || Number(draft.intervalCount) <= 0) {
    blockers.push('set a valid repeat count');
  }

  return blockers;
}
