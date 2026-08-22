// Cross-payment money math for the payments UI. Every figure here that
// compares payments on different cadences (weekly vs monthly vs
// quarterly, …) MUST go through `annualizedAmount` first and divide down
// from there — never multiply a single period's amount up. A fortnightly
// payment is ~26/year, not 24 (2 × 12): `amount × 2` reads as a
// reasonable "monthly" estimate and is wrong twice a year, which is
// exactly the kind of bug that survives casual testing.
//
// It lived under `src/v2/lib/` until SC-320. Twelve v3 modules imported it
// from there, which made a module v3 depends on part of the tree v2's
// retirement deletes — and hid its one user-facing string from every scan
// of `src/v3`.

import { Decimal } from '@scani/shared';
import type { TFunction } from 'i18next';

export const PAYMENT_INTERVAL_UNITS = ['week', 'month', 'quarter', 'year'] as const;

export type PaymentIntervalUnit = (typeof PAYMENT_INTERVAL_UNITS)[number];

const OCCURRENCES_PER_YEAR: Record<PaymentIntervalUnit, number> = {
  week: 52,
  month: 12,
  quarter: 4,
  year: 1,
};

const isPaymentIntervalUnit = (value: string): value is PaymentIntervalUnit =>
  (PAYMENT_INTERVAL_UNITS as readonly string[]).includes(value);

/**
 * `payment.intervalUnit` crosses the wire as a bare `string` (a Drizzle
 * `text()` column has no literal-union type), even though every write
 * path validates it against this same enum via the router's
 * `PAYMENT_INTERVAL_UNIT` zod schema. Narrows it back to the literal
 * union once, here, instead of an `as PaymentIntervalUnit` cast at every
 * page that reads a payment off the wire.
 *
 * Throws, so it belongs on the paths that go on to do arithmetic — a
 * cadence nobody can price cannot be annualised, and a wrong number is
 * worse than a stopped render. Display goes through
 * `formatPaymentInterval`, which is total.
 */
export function asPaymentIntervalUnit(value: string): PaymentIntervalUnit {
  if (isPaymentIntervalUnit(value)) {
    return value;
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

/**
 * A count of interval units, pluralised, under one key namespace.
 *
 * One pluralised key PER UNIT is the shape that works, because pluralisation
 * is a property of the noun and i18next selects on `count`. English needs two
 * forms; Russian needs three, and a frame like `Every {{count}} {{unit}}`
 * hands the translator the nominative singular of a noun that arrives as
 * untranslated wire data, with no way to decline it. That frame is exactly
 * what SC-235 removed from the account export and what SC-320 removed here.
 *
 * An unrecognised unit falls back to `{{count}} × {{unit}}` — deliberately not
 * prose. It cannot be made to agree, and printing the raw value with a
 * multiplication sign says "this is data we did not understand" rather than
 * inventing grammar around it.
 *
 * The namespace is a literal union rather than a free string so that adding a
 * third caller is a decision about which keys exist, made here.
 */
export function formatIntervalUnits(
  t: TFunction,
  namespace: 'v3.money.cadence' | 'v3.export.value',
  unit: string,
  count: number
): string {
  if (!isPaymentIntervalUnit(unit)) return t(`${namespace}.everyUnknown`, { count, unit });
  return t(`${namespace}.every_${unit}`, { count });
}

/**
 * Human-readable cadence, e.g. "Every 2 weeks" / "Every month".
 *
 * Takes the raw wire value, not a narrowed unit: a cadence nobody recognises
 * still has a vendor and an amount worth rendering beside it, so the display
 * path is total where the arithmetic path throws.
 */
export function formatPaymentInterval(t: TFunction, unit: string, count: number): string {
  return formatIntervalUnits(t, 'v3.money.cadence', unit, count);
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
const RATE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface UnconvertedPart {
  currencyTokenId: string;
  amount: Decimal;
}

/**
 * Whether the rates behind a conversion are the final answer (SC-210).
 *
 * A currency absent from the rate map means one of two unrelated things, and
 * until this type existed the conversion could not tell them apart: either the
 * rate does not exist, or we have not been told yet. Both produced the same
 * `undefined`, so a figure computed mid-flight was indistinguishable from a
 * finished one — the Money tab showed the USD-only sum of a multi-currency
 * book, then replaced it seconds later with a figure twice its size, and when
 * the rates query failed it kept the smaller number for good.
 *
 * `unavailable` covers both ways the answer never comes: the rates query
 * errored, or the base currency itself never resolved, and so nothing can be
 * converted into anything.
 */
export type RatesStatus = 'ready' | 'loading' | 'unavailable';

export interface BaseCurrencyTotal {
  /** Everything that could be expressed in base currency, added up. */
  amount: Decimal;
  /** Currencies folded into `amount` through a rate — base itself excluded. */
  convertedFrom: string[];
  /**
   * Parts the rate source answered for and had no rate for. Never added to
   * `amount`, and never dropped: omitting them silently would understate what
   * the user owes. A fact about the CURRENCY.
   */
  unconverted: UnconvertedPart[];
  /**
   * Parts whose rate nobody has told us yet, or ever will. Also never added
   * and never dropped — but a fact about the FETCH, not about the currency,
   * so the sentence a caller prints about these is a different sentence.
   */
  unknown: UnconvertedPart[];
  /** The oldest rate behind `amount`. `null` when nothing was converted. */
  ratesAsOf: Date | null;
  /** `ratesAsOf` is older than `RATE_STALE_AFTER_MS`. */
  stale: boolean;
  /** The status the figure was computed under, carried so a caller branching
   *  on it does not need the context as well. */
  ratesStatus: RatesStatus;
  /**
   * **`amount` is not a total.** Something is missing from it that a later
   * render is expected to supply, so presenting it as the answer shows a
   * number that is about to change. The one property this whole type exists
   * to make un-ignorable.
   */
  pending: boolean;
}

export interface ConversionContext {
  /** `null` until the base currency query resolves — nothing converts yet. */
  baseCurrencyTokenId: string | null;
  rateByCurrencyTokenId: ReadonlyMap<string, BaseCurrencyRate | null>;
  /**
   * Required, and deliberately not defaulted: `'ready'` is exactly the wrong
   * assumption while a query is in flight, and a default is how the caller
   * that most needs to think about this stops thinking about it. Every call
   * site holds a query state — pass it.
   */
  ratesStatus: RatesStatus;
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
  { baseCurrencyTokenId, rateByCurrencyTokenId, ratesStatus, now = new Date() }: ConversionContext
): BaseCurrencyTotal {
  let amount = new Decimal(0);
  const convertedFrom: string[] = [];
  const unconverted: UnconvertedPart[] = [];
  const unknown: UnconvertedPart[] = [];
  let oldest: Date | null = null;

  for (const [currencyTokenId, total] of totals) {
    if (currencyTokenId === baseCurrencyTokenId) {
      amount = amount.plus(total);
      continue;
    }

    const rate = rateByCurrencyTokenId.get(currencyTokenId) ?? null;
    if (!rate) {
      // `has()` is the whole distinction: an entry the rate source answered
      // for with no rate is a currency nobody can price, while a currency the
      // map has never heard of is one we have not asked about yet — unless the
      // rates are `ready`, in which case the answer came back without it and
      // "no rate" is what that means.
      const answered = rateByCurrencyTokenId.has(currencyTokenId) || ratesStatus === 'ready';
      (answered ? unconverted : unknown).push({ currencyTokenId, amount: total });
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
    unknown,
    ratesAsOf: convertedFrom.length > 0 ? oldest : null,
    stale: oldest !== null && now.getTime() - oldest.getTime() > RATE_STALE_AFTER_MS,
    ratesStatus,
    // Only `loading` is pending: an `unavailable` figure is missing the same
    // parts, but no later render is coming to fill them in, so a caller that
    // waits for one waits forever. That case gets a sentence, not a skeleton.
    pending: unknown.length > 0 && ratesStatus === 'loading',
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
