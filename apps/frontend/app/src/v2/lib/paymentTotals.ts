// Cross-payment money math for the payments UI. Every figure here that
// compares payments on different cadences (weekly vs monthly vs
// quarterly, …) MUST go through `annualizedAmount` first and divide down
// from there — never multiply a single period's amount up. A fortnightly
// payment is ~26/year, not 24 (2 × 12): `amount × 2` reads as a
// reasonable "monthly" estimate and is wrong twice a year, which is
// exactly the kind of bug that survives casual testing.

import { Decimal } from '@scani/shared';

export type PaymentIntervalUnit = 'week' | 'month' | 'quarter' | 'year';

const OCCURRENCES_PER_YEAR: Record<PaymentIntervalUnit, number> = {
  week: 52,
  month: 12,
  quarter: 4,
  year: 1,
};

const INTERVAL_UNITS: readonly string[] = Object.keys(OCCURRENCES_PER_YEAR);

/**
 * `payment.intervalUnit` crosses the wire as a bare `string` (a Drizzle
 * `text()` column has no literal-union type), even though every write
 * path validates it against this same enum via the router's
 * `PAYMENT_INTERVAL_UNIT` zod schema. Narrows it back to the literal
 * union once, here, instead of an `as PaymentIntervalUnit` cast at every
 * page that reads a payment off the wire.
 */
export function asPaymentIntervalUnit(value: string): PaymentIntervalUnit {
  if (INTERVAL_UNITS.includes(value)) {
    return value as PaymentIntervalUnit;
  }
  throw new Error(`Unknown payment interval unit: ${value}`);
}

/** How many times a year a payment on this schedule falls due. */
export function occurrencesPerYear(
  intervalUnit: PaymentIntervalUnit,
  intervalCount: number
): number {
  if (intervalCount <= 0) return 0;
  return OCCURRENCES_PER_YEAR[intervalUnit] / intervalCount;
}

/**
 * A payment's total yearly commitment. The only place a period amount is
 * ever scaled up — everything derived from it (monthly, weekly, …) divides
 * back down from this, so every unit lands on the same annual basis
 * before comparison.
 */
export function annualizedAmount(
  amount: string | number,
  intervalUnit: PaymentIntervalUnit,
  intervalCount: number
): Decimal {
  return new Decimal(amount).times(occurrencesPerYear(intervalUnit, intervalCount));
}

/** Annualise, then divide by 12 — the only correct way to get a "per month" figure. */
export function monthlyEquivalent(
  amount: string | number,
  intervalUnit: PaymentIntervalUnit,
  intervalCount: number
): Decimal {
  return annualizedAmount(amount, intervalUnit, intervalCount).dividedBy(12);
}

/** Human-readable cadence, e.g. "Every 2 weeks" / "Every month". */
export function formatPaymentInterval(
  intervalUnit: PaymentIntervalUnit,
  intervalCount: number
): string {
  if (intervalCount === 1) return `Every ${intervalUnit}`;
  return `Every ${intervalCount} ${intervalUnit}s`;
}

/**
 * User-facing wording for an occurrence's status.
 *
 * The stored value is `matched`, a leftover from the dropped detection
 * design — it describes how the row got settled, not what happened, and
 * it means nothing to someone reading their own bills. Direction decides
 * the verb for the same reason "Mark as paid" is wrong on a salary: money
 * arriving is received, not paid.
 */
export function formatOccurrenceStatus(status: string, direction: string): string {
  switch (status) {
    case 'matched':
      return direction === 'inflow' ? 'Received' : 'Paid';
    case 'scheduled':
      return 'Scheduled';
    case 'skipped':
      return 'Skipped';
    case 'missed':
      return 'Missed';
    default:
      return status;
  }
}

/**
 * Today as `YYYY-MM-DD`, matching the shape `paymentOccurrences.dueDate`
 * is stored and returned in, so callers can compare due dates as plain
 * strings.
 *
 * `payments.upcoming` deliberately returns every scheduled occurrence up
 * to the horizon INCLUDING overdue ones — the overview page needs both —
 * so any surface that says "upcoming" has to split on this itself.
 */
export function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface CurrencyAmount {
  amount: string;
  currencyTokenId: string;
}

/** Groups raw (non-annualised) amounts by currency token — for summing occurrences that already share a due-date window, e.g. "committed outflow in the next 30 days". */
export function sumAmountsByCurrency(entries: readonly CurrencyAmount[]): Map<string, Decimal> {
  const totals = new Map<string, Decimal>();
  for (const entry of entries) {
    const running = totals.get(entry.currencyTokenId) ?? new Decimal(0);
    totals.set(entry.currencyTokenId, running.plus(new Decimal(entry.amount)));
  }
  return totals;
}

export interface MonthlyEquivalentInput {
  expectedAmount: string | null;
  intervalUnit: PaymentIntervalUnit;
  intervalCount: number;
  currencyTokenId: string;
}

/**
 * Sums several payments' monthly-equivalent commitment, grouped by
 * currency. This is the cross-payment comparison the annualisation rule
 * exists for: a weekly $20 payment and a quarterly $300 payment can only
 * be added meaningfully once both are annualised and divided back to a
 * common (monthly) basis. Entries with no `expectedAmount` (variable-kind
 * payments with no estimate) are skipped — there's nothing to project.
 */
export function sumMonthlyEquivalentByCurrency(
  payments: readonly MonthlyEquivalentInput[]
): Map<string, Decimal> {
  const totals = new Map<string, Decimal>();
  for (const payment of payments) {
    if (payment.expectedAmount === null) continue;
    const monthly = monthlyEquivalent(
      payment.expectedAmount,
      payment.intervalUnit,
      payment.intervalCount
    );
    const running = totals.get(payment.currencyTokenId) ?? new Decimal(0);
    totals.set(payment.currencyTokenId, running.plus(monthly));
  }
  return totals;
}
