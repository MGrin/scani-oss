/**
 * Turns one parsed invoice into the recurring-payment form's starting
 * values.
 *
 * Kept out of the page because the defaulting rules are the part a human
 * has to trust: a single invoice proves an amount and a date but never a
 * cadence, so every rule here is a *suggestion* the user confirms before
 * anything is written.
 */

export type BillingPeriod = 'week' | 'month' | 'quarter' | 'year';
export type InvoicePaymentStatus = 'paid' | 'unpaid';

/**
 * The extraction fields the form reads. `paymentStatus` / `billingPeriod`
 * are optional because they are newer than the rows already in the table —
 * an extraction parsed before they existed carries neither, and the
 * defaults below have to hold for those too.
 */
export interface InvoiceExtractionSource {
  vendorNameRaw: string | null;
  totalAmount: string | null;
  currencyCode: string | null;
  issueDate: string | null;
  paymentStatus?: InvoicePaymentStatus | null;
  billingPeriod?: BillingPeriod | null;
}

export interface InvoicePrefill {
  /** Shown in the vendor picker; find-or-created server-side on submit. */
  vendorName: string;
  amount: string;
  /** e.g. `USD` — resolved to a real `tokens.id` by `matchCurrencyToken`. */
  currencyCode: string | null;
  anchorDate: string;
  intervalUnit: BillingPeriod;
  markAnchorPaid: boolean;
}

/**
 * Absent a `billingPeriod`, yearly is the safest guess: a monthly bill
 * suggested as yearly shows up late and the user notices, while a yearly
 * bill suggested as monthly invents eleven payments that never happen.
 */
const DEFAULT_INTERVAL_UNIT: BillingPeriod = 'year';

/**
 * Unpaid is the only status that means "this period is still owed".
 * A `null` status is treated as paid because the invoices users forward
 * are overwhelmingly receipts they have already settled — and getting it
 * wrong in that direction is visible (the upcoming payment is the one the
 * user just paid) rather than silent.
 */
export function defaultMarkAnchorPaid(status: InvoicePaymentStatus | null | undefined): boolean {
  return status !== 'unpaid';
}

export function buildInvoicePrefill(
  extraction: InvoiceExtractionSource,
  fallbackAnchorDate: string
): InvoicePrefill {
  return {
    vendorName: extraction.vendorNameRaw?.trim() ?? '',
    amount: extraction.totalAmount?.trim() ?? '',
    currencyCode: extraction.currencyCode?.trim() || null,
    anchorDate: extraction.issueDate ?? fallbackAnchorDate,
    intervalUnit: extraction.billingPeriod ?? DEFAULT_INTERVAL_UNIT,
    markAnchorPaid: defaultMarkAnchorPaid(extraction.paymentStatus),
  };
}

export interface CurrencyTokenCandidate {
  id: string;
  symbol: string;
  name: string;
  type?: string | null;
}

/**
 * Resolves an invoice's `currencyCode` to a token row.
 *
 * Prefers the fiat token when several rows share a symbol — `USD` also
 * exists as crypto tickers, and prefilling one of those would quietly
 * price a bill in the wrong asset.
 */
export function matchCurrencyToken<T extends CurrencyTokenCandidate>(
  tokens: readonly T[],
  currencyCode: string | null
): T | null {
  if (!currencyCode) return null;
  const wanted = currencyCode.trim().toUpperCase();
  if (!wanted) return null;
  const matches = tokens.filter((token) => token.symbol.toUpperCase() === wanted);
  return matches.find((token) => token.type === 'fiat') ?? matches[0] ?? null;
}
