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
  dueDate?: string | null;
  paymentStatus?: string | null;
  billingPeriod?: string | null;
}

const BILLING_PERIODS: readonly string[] = ['week', 'month', 'quarter', 'year'];

/**
 * Both columns are plain `text` with no CHECK constraint, and the API
 * returns them as the raw column type. The extractor normalises before
 * writing, but nothing in the database stops a future writer putting
 * something else there — so narrow at the boundary rather than asserting.
 * An unrecognised value falls through to the same defaults as NULL.
 */
function asBillingPeriod(value: string | null | undefined): BillingPeriod | null {
  return value && BILLING_PERIODS.includes(value) ? (value as BillingPeriod) : null;
}

function asPaymentStatus(value: string | null | undefined): InvoicePaymentStatus | null {
  return value === 'paid' || value === 'unpaid' ? value : null;
}

/**
 * Which of the invoice's dates the anchor came from — the part of the
 * prefill a human most needs to see, because only `due-date` is evidence.
 * `issue-date` is a substitution and `none` is an empty field the user has
 * to fill, and both used to look identical to a confirmed due date.
 */
export type AnchorDateSource = 'due-date' | 'issue-date' | 'none';

export interface InvoicePrefill {
  /** Shown in the vendor picker; find-or-created server-side on submit. */
  vendorName: string;
  amount: string;
  /** e.g. `USD` — resolved to a real `tokens.id` by `matchCurrencyToken`. */
  currencyCode: string | null;
  /** `''` when the invoice evidenced no date at all — never today's date. */
  anchorDate: string;
  anchorDateSource: AnchorDateSource;
  /**
   * `null` when the invoice stated no cadence — an unanswered question the
   * form has to put to the user, NOT a value it may pick for them.
   */
  intervalUnit: BillingPeriod | null;
  markAnchorPaid: boolean;
}

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

/**
 * The anchor is the day every future occurrence of the bill lands on, so
 * it comes off the *due* date when the invoice states one. Anchoring on
 * the issue date instead is only right when the two coincide: the Aug-13
 * invoice due Aug-23 in production would have been scheduled ten days
 * early, every month, with nothing on screen saying so.
 *
 * Neither date present is an empty field, NOT today. Today is a real,
 * plausible-looking date the user cannot distinguish from one the
 * document actually carried — and `describePaymentFormBlockers` already
 * refuses to submit an empty anchor, so the empty string is the shortest
 * path to "you have to tell us this one".
 */
function resolveAnchor(extraction: InvoiceExtractionSource): {
  anchorDate: string;
  anchorDateSource: AnchorDateSource;
} {
  const dueDate = extraction.dueDate?.trim();
  if (dueDate) return { anchorDate: dueDate, anchorDateSource: 'due-date' };
  const issueDate = extraction.issueDate?.trim();
  if (issueDate) return { anchorDate: issueDate, anchorDateSource: 'issue-date' };
  return { anchorDate: '', anchorDateSource: 'none' };
}

/**
 * A `billingPeriod` the extractor could not read is left empty, the same
 * way a missing date is (`resolveAnchor`), and for the same reason.
 *
 * This used to default to yearly, on the argument that a monthly bill
 * suggested as yearly shows up late and gets noticed. It does not get
 * noticed: the extractor reports a cadence only when the invoice states one
 * in words, and most invoices state none — so the default fired on the
 * common case, wrote `interval_unit=year` for a £146/month bill, and the
 * Money page reported "Committed each month £12.17" (SC-147). One twelfth of
 * a real commitment, on a screen whose whole job is to total commitments.
 *
 * Neither direction is safe enough to guess: yearly under-reports by 12x,
 * monthly invents eleven charges. The honest move is the empty field —
 * `describePaymentFormBlockers` refuses to submit without one, so the user
 * answers the one question the document genuinely did not.
 */
export function buildInvoicePrefill(extraction: InvoiceExtractionSource): InvoicePrefill {
  return {
    vendorName: extraction.vendorNameRaw?.trim() ?? '',
    amount: extraction.totalAmount?.trim() ?? '',
    currencyCode: extraction.currencyCode?.trim() || null,
    ...resolveAnchor(extraction),
    intervalUnit: asBillingPeriod(extraction.billingPeriod),
    markAnchorPaid: defaultMarkAnchorPaid(asPaymentStatus(extraction.paymentStatus)),
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
