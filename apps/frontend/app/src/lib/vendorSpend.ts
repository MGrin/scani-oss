import { Decimal, formatCurrency } from '@scani/shared';
import {
  asPaymentIntervalUnit,
  type ConversionContext,
  convertTotalsToBase,
  sumAmountsByCurrency,
  sumMonthlyEquivalentByCurrency,
} from '@/v2/lib/paymentTotals';

/**
 * "How much do I pay this vendor" — the two answers, kept apart.
 *
 * The question is ambiguous and both readings are useful, so both are here
 * and neither is allowed to stand in for the other:
 *
 * - **Committed per month** — what the vendor's *active* recurring payments
 *   add up to on a monthly basis. Comparable across vendors regardless of
 *   when each was set up, which is why it is the figure the list sorts on.
 *   It is a claim about the future and it is not money that has moved.
 * - **Paid** — what has actually settled, over a stated window and over all
 *   time. A claim about the past, from `matched` occurrences only.
 *
 * A surface may show both. It may never add them together or print one under
 * a label that names the other: a vendor set up yesterday commits €50 a month
 * and has paid €0, and both numbers are correct.
 *
 * Lives above the v2/v3 split because both trees show it and v2 is still the
 * default tree. Conversion into the base currency is delegated to
 * `paymentTotals` — there is one rate path in this app and this is not a
 * second one.
 */

/** The two directions money moves. Written down once so no surface decides
 *  for itself what the free-text `direction` column is allowed to say. */
export const OUTFLOW = 'outflow';
export const INFLOW = 'inflow';

/**
 * What kind of counterparty a vendor is, from the directions its money
 * actually moves in.
 *
 * This exists because filtering to `outflow` and calling the remainder nothing
 * is what made a €5,850-a-month employer render as `Employer · 1 payment —
 * €0.00` under a heading reading "Committed per month" (SC-78 §5). The
 * filtering itself was right — SC-61 separated the directions precisely so an
 * inflow could never be counted as spend — but a filter is not a classifier,
 * and everything it dropped landed in the one bucket that looks like a real
 * answer: zero.
 *
 * Same failure shape as SC-76's `outcome !== 'ok'`: a binary over a field with
 * more than two values, where the unrecognised case silently takes the wrong
 * branch. So both directions are named, and a row in neither is
 * `unclassified` rather than quietly counted as spend or quietly reported as
 * €0.00.
 */
export type VendorDirectionKind = 'spend' | 'income' | 'both' | 'unclassified' | 'none';

/** The two fields the classification reads — satisfied by a payment row and by
 *  a `vendors.spend` total alike, so both feed the same answer. */
export interface DirectedVendorRow {
  vendorId: string;
  direction: string;
}

export function vendorDirectionKinds(
  rows: readonly DirectedVendorRow[]
): Map<string, VendorDirectionKind> {
  const seen = new Map<string, { inflow: boolean; outflow: boolean; other: boolean }>();
  for (const row of rows) {
    const entry = seen.get(row.vendorId) ?? { inflow: false, outflow: false, other: false };
    if (row.direction === INFLOW) entry.inflow = true;
    else if (row.direction === OUTFLOW) entry.outflow = true;
    else entry.other = true;
    seen.set(row.vendorId, entry);
  }

  const kinds = new Map<string, VendorDirectionKind>();
  for (const [vendorId, entry] of seen) {
    if (entry.inflow && entry.outflow) kinds.set(vendorId, 'both');
    else if (entry.inflow) kinds.set(vendorId, 'income');
    else if (entry.outflow) kinds.set(vendorId, 'spend');
    // Rows exist but none of them is in a direction we understand. Not `none`
    // — `none` means "nothing points here", which is a figure of zero, and
    // this is the case where we must not print one.
    else if (entry.other) kinds.set(vendorId, 'unclassified');
  }
  return kinds;
}

/** A vendor nothing points at. `none` rather than `undefined` so a caller
 *  never has to decide what a missing entry meant. */
export function vendorDirectionKind(
  kinds: Map<string, VendorDirectionKind>,
  vendorId: string
): VendorDirectionKind {
  return kinds.get(vendorId) ?? 'none';
}

/** Whether this vendor's own figure is money arriving. `both` is not income:
 *  a vendor you also pay is shown as a bill, with its income beside it in the
 *  peek — the two are never one number. */
export function isIncomeVendor(kind: VendorDirectionKind): boolean {
  return kind === 'income';
}

/** Mirrors `vendors.spend`'s `totals` rows. */
export interface VendorSpendTotal {
  vendorId: string;
  currencyTokenId: string;
  direction: string;
  allTime: string;
  inWindow: string;
  settledCount: number;
  unpricedCount: number;
}

/** Mirrors `vendors.spend`'s `recent` rows. */
export interface VendorSettlement {
  id: string;
  vendorId: string;
  paymentId: string;
  dueDate: string;
  amount: string | null;
  currencyTokenId: string;
  direction: string;
}

export interface CommitmentInput {
  vendorId: string;
  expectedAmount: string | null;
  intervalUnit: string;
  intervalCount: number;
  currencyTokenId: string;
  direction: string;
  status: string;
}

/** Per-currency monthly commitment, per vendor. Only what is still running
 *  counts: a paused or ended payment commits the user to nothing. */
export function monthlyCommitmentByVendor(
  payments: readonly CommitmentInput[],
  direction = 'outflow'
): Map<string, Map<string, Decimal>> {
  const byVendor = new Map<string, CommitmentInput[]>();
  for (const payment of payments) {
    if (payment.status !== 'active' || payment.direction !== direction) continue;
    const bucket = byVendor.get(payment.vendorId);
    if (bucket) bucket.push(payment);
    else byVendor.set(payment.vendorId, [payment]);
  }

  const totals = new Map<string, Map<string, Decimal>>();
  for (const [vendorId, vendorPayments] of byVendor) {
    totals.set(
      vendorId,
      sumMonthlyEquivalentByCurrency(
        vendorPayments.map((payment) => ({
          expectedAmount: payment.expectedAmount,
          intervalUnit: asPaymentIntervalUnit(payment.intervalUnit),
          intervalCount: payment.intervalCount,
          currencyTokenId: payment.currencyTokenId,
        }))
      )
    );
  }
  return totals;
}

export interface VendorSettled {
  inWindow: Map<string, Decimal>;
  allTime: Map<string, Decimal>;
  settledCount: number;
  /** Settlements carrying no amount — money that moved but was never priced.
   *  Missing from both sums, so a surface printing them must say so. */
  unpricedCount: number;
}

const EMPTY_SETTLED: VendorSettled = {
  inWindow: new Map(),
  allTime: new Map(),
  settledCount: 0,
  unpricedCount: 0,
};

/** The zero a vendor with no settlements reads as — never `undefined`, so a
 *  row shows "€0.00" rather than going blank. */
export function noSettledSpend(): VendorSettled {
  return EMPTY_SETTLED;
}

export function settledByVendor(
  totals: readonly VendorSpendTotal[],
  direction = 'outflow'
): Map<string, VendorSettled> {
  const byVendor = new Map<string, VendorSettled>();
  for (const row of totals) {
    if (row.direction !== direction) continue;
    const existing = byVendor.get(row.vendorId) ?? {
      inWindow: new Map<string, Decimal>(),
      allTime: new Map<string, Decimal>(),
      settledCount: 0,
      unpricedCount: 0,
    };
    existing.inWindow.set(
      row.currencyTokenId,
      (existing.inWindow.get(row.currencyTokenId) ?? new Decimal(0)).plus(new Decimal(row.inWindow))
    );
    existing.allTime.set(
      row.currencyTokenId,
      (existing.allTime.get(row.currencyTokenId) ?? new Decimal(0)).plus(new Decimal(row.allTime))
    );
    existing.settledCount += row.settledCount;
    existing.unpricedCount += row.unpricedCount;
    byVendor.set(row.vendorId, existing);
  }
  return byVendor;
}

export function settlementsByVendor(
  settlements: readonly VendorSettlement[],
  direction = 'outflow'
): Map<string, VendorSettlement[]> {
  const byVendor = new Map<string, VendorSettlement[]>();
  for (const settlement of settlements) {
    if (settlement.direction !== direction) continue;
    const bucket = byVendor.get(settlement.vendorId);
    if (bucket) bucket.push(settlement);
    else byVendor.set(settlement.vendorId, [settlement]);
  }
  return byVendor;
}

/**
 * The one comparable number behind a row — its monthly commitment expressed
 * in base currency. Sorting on the per-currency map directly would order a
 * £10 vendor above a €100 one, which is the defect the conversion exists to
 * fix; parts with no rate are simply absent from it, exactly as they are
 * absent from the figure the row shows.
 */
export function comparableBaseAmount(
  totals: Map<string, Decimal> | undefined,
  context: ConversionContext
): number {
  if (!totals || totals.size === 0) return 0;
  return convertTotalsToBase(totals, context).amount.toNumber();
}

/** Adds a vendor's per-currency settlements into one map, for a summary that
 *  spans the filtered rows. */
export function mergeCurrencyTotals(maps: readonly Map<string, Decimal>[]): Map<string, Decimal> {
  return sumAmountsByCurrency(
    maps.flatMap((map) =>
      Array.from(map, ([currencyTokenId, amount]) => ({
        currencyTokenId,
        amount: amount.toString(),
      }))
    )
  );
}

/**
 * A converted figure as plain text, for v2 — which has no `<Numeric>` and
 * formats money as strings.
 *
 * Same rule as v3's `<ConvertedFigure>`: a part with no rate is printed
 * beside the total rather than folded in or dropped, so a vendor billed only
 * in a currency we cannot convert never reads as costing nothing.
 */
export function formatConvertedFigure(
  totals: ReadonlyMap<string, Decimal>,
  context: ConversionContext,
  baseSymbol: string,
  symbolFor: (currencyTokenId: string) => string
): string {
  const total = convertTotalsToBase(totals, context);
  const base = formatCurrency(total.amount.toString(), baseSymbol);
  if (total.unconverted.length === 0) return base;
  const rest = total.unconverted
    .map((part) => formatCurrency(part.amount.toString(), symbolFor(part.currencyTokenId)))
    .join(' + ');
  return `${base} + ${rest} unconverted`;
}

/** "Paid, last 12 months". The window is always in the label — an unqualified
 *  total is a figure nobody can act on. */
export function paidWindowLabel(windowMonths: number): string {
  return windowMonths === 12 ? 'Paid, last 12 months' : `Paid, last ${windowMonths} months`;
}

export const COMMITMENT_LABEL = 'Committed per month';
export const PAID_ALL_TIME_LABEL = 'Paid, all time';

/**
 * The income wording, kept apart from the spend wording rather than reusing it
 * with a different figure.
 *
 * "Committed" is wrong for money arriving: a bill is an obligation and income
 * is a forecast, which is the distinction V3-47 built the whole two-figure rule
 * on. "Expected" carries it. Likewise "Paid" describes money you sent, so a
 * salary that landed is "Received".
 */
export const INCOME_COMMITMENT_LABEL = 'Expected per month';
export const RECEIVED_ALL_TIME_LABEL = 'Received, all time';

export function receivedWindowLabel(windowMonths: number): string {
  return windowMonths === 12 ? 'Received, last 12 months' : `Received, last ${windowMonths} months`;
}

/**
 * The name the vendor list's money column carries.
 *
 * Deliberately direction-neutral. SC-69 3.3 required the phone list's value
 * zone to be named at all — an unheaded money column under a summary holding
 * two labelled totals belongs to neither of them — and "Committed per month"
 * did that job while every row was a bill. It stopped being true the moment an
 * income vendor appeared in the same column, so the header names the period
 * the whole column shares and each row states its own direction: income
 * carries `<Numeric delta>`'s sign and gain token, and says "Income" in its
 * sublabel. The two are never added together anywhere.
 */
export const PER_MONTH_LABEL = 'Per month';

/** "Income" / "Bills & income" / "Bill" — what a row says it is. `null` where
 *  the direction adds nothing a reader needs (an ordinary bill, or a vendor
 *  with nothing pointing at it). */
export function vendorKindLabel(kind: VendorDirectionKind): string | null {
  switch (kind) {
    case 'income':
      return 'Income';
    case 'both':
      return 'Bills & income';
    case 'unclassified':
      return 'Direction not recorded';
    default:
      return null;
  }
}

/** "2 settlements have no amount recorded" — said only when it is true, and
 *  next to the total it is missing from. */
export function unpricedNote(unpricedCount: number): string | null {
  if (unpricedCount <= 0) return null;
  return unpricedCount === 1
    ? '1 settlement has no amount recorded and is not in this total.'
    : `${unpricedCount} settlements have no amount recorded and are not in this total.`;
}
