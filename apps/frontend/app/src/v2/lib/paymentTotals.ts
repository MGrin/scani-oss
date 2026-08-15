// Cross-payment money math for the payments UI. Every figure here that
// compares payments on different cadences (weekly vs monthly vs
// quarterly, …) MUST go through `annualizedAmount` first and divide down
// from there — never multiply a single period's amount up. A fortnightly
// payment is ~26/year, not 24 (2 × 12): `amount × 2` reads as a
// reasonable "monthly" estimate and is wrong twice a year, which is
// exactly the kind of bug that survives casual testing.

import { Decimal, formatCurrency, formatDate } from '@scani/shared';

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

/**
 * ─── Converting a per-currency total into one base-currency figure ───
 *
 * `sumAmountsByCurrency` / `sumMonthlyEquivalentByCurrency` stay the
 * primitive — "what do I owe in each currency" is a real question and the
 * only honest way to add unlike currencies is not to. What changed is the
 * *presentation*: we hold FX rates, so a total that spans currencies is
 * converted into the base currency and printed as one number, with the
 * conversion said out loud. "€94.97 · Plus $23.00" answered a question
 * nobody asked.
 *
 * Rates come from `tokens.getBaseCurrencyRates`, which is the same
 * `CurrencyConverter` every portfolio valuation goes through. There is no
 * second rate path and no rate arithmetic in a component.
 */

export interface BaseCurrencyRate {
  /** Multiply an amount in this currency by `rate` to reach base currency. */
  rate: string;
  /** ISO instant the rate is from. `null` when the source didn't say. */
  asOf: string | null;
}

/**
 * Past this, a rate is described rather than presented as current. It
 * matches `CurrencyConverter.DB_RATE_MAX_AGE_MS` — the converter refuses
 * to serve a stored rate older than a day without trying upstream first,
 * so anything older than this reaching the UI means upstream is down and
 * the reader deserves to know.
 */
export const RATE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface UnconvertedPart {
  currencyTokenId: string;
  amount: Decimal;
}

export interface BaseCurrencyTotal {
  /** Everything that could be expressed in base currency, added up. */
  amount: Decimal;
  /** Currencies folded into `amount` through a rate — base itself excluded. */
  convertedFrom: string[];
  /**
   * Parts with no usable rate. Never added to `amount`, and never dropped:
   * omitting them silently would understate what the user owes.
   */
  unconverted: UnconvertedPart[];
  /** The oldest rate behind `amount`. `null` when nothing was converted. */
  ratesAsOf: Date | null;
  /** `ratesAsOf` is older than `RATE_STALE_AFTER_MS`. */
  stale: boolean;
}

export interface ConversionContext {
  /** `null` until the base currency query resolves — nothing converts yet. */
  baseCurrencyTokenId: string | null;
  rateByCurrencyTokenId: ReadonlyMap<string, BaseCurrencyRate | null>;
  /** Injectable for tests; defaults to now. */
  now?: Date;
}

function rateAsOf(rate: BaseCurrencyRate): Date | null {
  if (!rate.asOf) return null;
  const parsed = new Date(rate.asOf);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * One base-currency figure out of a per-currency map.
 *
 * The base currency's own part passes through untouched (rate 1, and it
 * never appears in `convertedFrom` — "converted from EUR to EUR" is
 * noise). Every other part needs a rate; without one it lands in
 * `unconverted` for the caller to print beside the total.
 */
export function convertTotalsToBase(
  totals: ReadonlyMap<string, Decimal>,
  { baseCurrencyTokenId, rateByCurrencyTokenId, now = new Date() }: ConversionContext
): BaseCurrencyTotal {
  let amount = new Decimal(0);
  const convertedFrom: string[] = [];
  const unconverted: UnconvertedPart[] = [];
  let oldest: Date | null = null;

  for (const [currencyTokenId, total] of totals) {
    if (currencyTokenId === baseCurrencyTokenId) {
      amount = amount.plus(total);
      continue;
    }

    const rate = rateByCurrencyTokenId.get(currencyTokenId) ?? null;
    if (!rate) {
      unconverted.push({ currencyTokenId, amount: total });
      continue;
    }

    amount = amount.plus(total.times(new Decimal(rate.rate)));
    convertedFrom.push(currencyTokenId);
    const at = rateAsOf(rate);
    if (at && (!oldest || at < oldest)) oldest = at;
  }

  return {
    amount,
    convertedFrom,
    unconverted,
    ratesAsOf: convertedFrom.length > 0 ? oldest : null,
    stale: oldest !== null && now.getTime() - oldest.getTime() > RATE_STALE_AFTER_MS,
  };
}

export interface ConvertedAmount {
  amount: Decimal;
  stale: boolean;
}

/**
 * The base-currency equivalent of a single row's amount, for the
 * secondary line under it. `null` means there is nothing to add: the row
 * is already in base currency, has no amount, or has no rate — in the
 * last case the row keeps standing on its own figure rather than
 * sprouting an apology.
 */
export function convertAmountToBase(
  amount: string | null,
  currencyTokenId: string,
  { baseCurrencyTokenId, rateByCurrencyTokenId, now = new Date() }: ConversionContext
): ConvertedAmount | null {
  if (amount === null || !baseCurrencyTokenId || currencyTokenId === baseCurrencyTokenId) {
    return null;
  }
  const rate = rateByCurrencyTokenId.get(currencyTokenId) ?? null;
  if (!rate) return null;

  const at = rateAsOf(rate);
  return {
    amount: new Decimal(amount).times(new Decimal(rate.rate)),
    stale: at !== null && now.getTime() - at.getTime() > RATE_STALE_AFTER_MS,
  };
}

/**
 * The sentence that goes under a converted total, as plain text.
 *
 * Says three things, in this order of importance: what could NOT be
 * converted (money missing from the figure above), how old the rates are
 * when that is worth saying, and — otherwise — simply that a conversion
 * happened. `null` when the total is single-currency and the figure needs
 * no qualification at all.
 */
export function describeConversion(
  total: BaseCurrencyTotal,
  symbolFor: (currencyTokenId: string) => string
): string | null {
  const parts: string[] = [];

  if (total.convertedFrom.length > 0) {
    const currencies = total.convertedFrom.map(symbolFor).join(', ');
    parts.push(
      total.stale && total.ratesAsOf
        ? `Converted from ${currencies} at rates from ${formatDate(total.ratesAsOf.toISOString())}`
        : `Converted from ${currencies} at today's rates`
    );
  }

  if (total.unconverted.length > 0) {
    const amounts = total.unconverted
      .map((part) => formatCurrency(part.amount.toString(), symbolFor(part.currencyTokenId)))
      .join(', ');
    parts.push(`${amounts} not included — no recent rate`);
  }

  return parts.length > 0 ? parts.join('. ') : null;
}
