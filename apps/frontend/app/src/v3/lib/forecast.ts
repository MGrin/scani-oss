import { Decimal } from '@scani/shared';
import { type ConversionContext, convertTotalsToBase, type UnconvertedPart } from './paymentTotals';

/**
 * The cashflow projection (SC-461) — the arithmetic behind a claim about the
 * future, kept out of the components that make it.
 *
 * Everything here is pure and takes its "today" as an argument, for the same
 * reason `lib/money.ts` does: a figure somebody will plan their year around
 * has to be assertable at a fixed date, and a projection that reads the clock
 * can only be tested against itself.
 *
 * ## The conversion rule this obeys (V3-52, SC-210)
 *
 * Movements arrive from `payments.forecast` in the currency that will actually
 * move, one per due date, and the base-currency figure is made HERE, through
 * `convertTotalsToBase` — the same single conversion path the bills total and
 * the income total on the Money tab already go through. So a projection can
 * never be as-of different rates than the figures above it, and it inherits
 * the two disclosures that path carries: what could not be converted, and
 * whether the rates are still in flight.
 *
 * `pending` is the one that matters most here. A projection computed while the
 * rates are still coming is the base-currency part alone — a burn missing
 * every foreign bill, which is to say a runway that is too long. It is
 * reported rather than rendered, and the surface shows a skeleton.
 */

/** The windows the reader can choose. */
export const FORECAST_HORIZONS = [3, 6, 12] as const;
export type ForecastHorizon = (typeof FORECAST_HORIZONS)[number];

/**
 * Six months (mgrin, 2026-08-26). Long enough that a quarterly cost and an
 * irregular client invoice both appear; short enough that most of it is still
 * backed by materialised occurrences rather than rule expansion.
 */
export const DEFAULT_FORECAST_HORIZON: ForecastHorizon = 6;

/** A dated movement, exactly as `payments.forecast` returns it. */
export interface ForecastMovementRow {
  dueDate: string;
  direction: string;
  currencyTokenId: string;
  amount: string;
}

/** One calendar month of the window, still per-currency. */
export interface MonthBucket {
  /** `YYYY-MM`. */
  key: string;
  outflow: Map<string, Decimal>;
  inflow: Map<string, Decimal>;
}

/** The months a window covers, starting with the one `today` falls in. */
export function monthSequence(today: string, months: number): string[] {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7)) - 1;
  return Array.from({ length: months }, (_, index) =>
    new Date(Date.UTC(year, month + index, 1)).toISOString().slice(0, 7)
  );
}

function addTo(totals: Map<string, Decimal>, currencyTokenId: string, amount: string): void {
  const running = totals.get(currencyTokenId) ?? new Decimal(0);
  totals.set(currencyTokenId, running.plus(new Decimal(amount)));
}

/**
 * Movements into month buckets.
 *
 * Every month in the window gets a bucket whether or not anything falls in it:
 * a projection with holes in the x-axis reads as a chart that stops, and a
 * quiet month is a fact about the book rather than missing data. Movements
 * outside the window are dropped — the caller chose the window.
 */
export function bucketMovements(
  movements: readonly ForecastMovementRow[],
  monthKeys: readonly string[]
): MonthBucket[] {
  const buckets = new Map<string, MonthBucket>(
    monthKeys.map((key) => [key, { key, outflow: new Map(), inflow: new Map() }])
  );
  for (const movement of movements) {
    const bucket = buckets.get(movement.dueDate.slice(0, 7));
    if (!bucket) continue;
    const side = movement.direction === 'inflow' ? bucket.inflow : bucket.outflow;
    addTo(side, movement.currencyTokenId, movement.amount);
  }
  return monthKeys.map((key) => buckets.get(key) as MonthBucket);
}

/** A one-off outflow the reader is asking whether they can afford. */
export interface OneOffOutflow {
  /** `YYYY-MM-DD`. */
  date: string;
  currencyTokenId: string;
  amount: string;
}

/**
 * The same window with one more outflow in it.
 *
 * Returns new buckets rather than mutating: the surface renders the projection
 * with and without it, and a shared map would make the "before" figure change
 * under the "after" one.
 */
export function withOneOff(buckets: readonly MonthBucket[], oneOff: OneOffOutflow): MonthBucket[] {
  const month = oneOff.date.slice(0, 7);
  return buckets.map((bucket) => {
    const copy: MonthBucket = {
      key: bucket.key,
      outflow: new Map(bucket.outflow),
      inflow: new Map(bucket.inflow),
    };
    if (bucket.key === month) addTo(copy.outflow, oneOff.currencyTokenId, oneOff.amount);
    return copy;
  });
}

export interface ProjectedPoint {
  /** `YYYY-MM`. */
  month: string;
  /** Base-currency balance at the END of this month. */
  balance: Decimal;
  /** What left and what arrived during it, in base currency. */
  outflow: Decimal;
  inflow: Decimal;
}

export interface Projection {
  /** The liquid balance the walk starts from. */
  opening: Decimal;
  points: ProjectedPoint[];
  /**
   * The rates have not arrived. `points` is the base-currency part alone and
   * must not be rendered — see the module doc.
   */
  pending: boolean;
  /** Currencies the rate source answered for with no rate, over the window. */
  unconverted: UnconvertedPart[];
  /** Currencies nothing has told us about, over the window. */
  unknown: UnconvertedPart[];
}

function mergeParts(into: Map<string, Decimal>, parts: readonly UnconvertedPart[]): void {
  for (const part of parts) {
    const running = into.get(part.currencyTokenId) ?? new Decimal(0);
    into.set(part.currencyTokenId, running.plus(part.amount));
  }
}

function asParts(totals: Map<string, Decimal>): UnconvertedPart[] {
  return [...totals].map(([currencyTokenId, amount]) => ({ currencyTokenId, amount }));
}

/**
 * The running balance, month by month, in base currency.
 *
 * The walk is monthly rather than per-movement on purpose: a daily line would
 * claim to know which day of the month a bill leaves relative to an invoice
 * arriving, and it does not — a due date is when money is *expected*, not when
 * it clears. A month is the finest grain the underlying data honestly supports.
 */
export function project(
  opening: Decimal,
  buckets: readonly MonthBucket[],
  rates: ConversionContext
): Projection {
  const points: ProjectedPoint[] = [];
  const unconverted = new Map<string, Decimal>();
  const unknown = new Map<string, Decimal>();
  let pending = false;
  let balance = opening;

  for (const bucket of buckets) {
    const out = convertTotalsToBase(bucket.outflow, rates);
    const into = convertTotalsToBase(bucket.inflow, rates);
    pending = pending || out.pending || into.pending;
    mergeParts(unconverted, out.unconverted);
    mergeParts(unconverted, into.unconverted);
    mergeParts(unknown, out.unknown);
    mergeParts(unknown, into.unknown);

    balance = balance.plus(into.amount).minus(out.amount);
    points.push({ month: bucket.key, balance, outflow: out.amount, inflow: into.amount });
  }

  return { opening, points, pending, unconverted: asParts(unconverted), unknown: asParts(unknown) };
}

/**
 * How long the liquid balance lasts.
 *
 * Two answers and no third, because THIS function has no honest third. Either
 * the walk reaches zero inside the window — a date, from dated movements — or
 * it does not, and the answer is "longer than this window". It will never
 * divide the book's own average and call the quotient a date.
 *
 * ## That is a rule about the BOOK, not about averages (SC-661)
 *
 * This doc used to end "an average monthly burn extrapolated past the last
 * month anybody has data for is arithmetic dressed as a forecast", full stop —
 * and `observedRunwayMonths` in `@scani/shared` now does exactly that, on the
 * surface directly above this one. Left as written, the rule reads as a
 * standing ban that a future reader would correctly apply to delete the
 * observed runway.
 *
 * The distinction it was actually protecting: extrapolating the RECURRING
 * BOOK past its window invents obligations nobody entered, because the book is
 * a finite list of dated commitments and running out of them is not evidence
 * of anything. Observed burn is a measured RATE — six complete months of money
 * that really left — and a rate is the one thing it is legitimate to divide
 * into a balance. It is also reported with its spread and its excluded counts
 * beside it, which is what keeps the single figure from being more confident
 * than the data.
 *
 * `netPerMonth` accompanies the second answer so the sentence can say what the
 * book is doing — `+€1,200 a month`, `−€300 a month` — without implying a date.
 */
export type Runway =
  | {
      kind: 'exhausted';
      /** `YYYY-MM`, the month the balance first reaches zero or below. */
      month: string;
      /** 0 = the month we are in now. */
      monthsFromNow: number;
    }
  | {
      kind: 'lasts';
      /** The window that was walked, in months. */
      beyondMonths: number;
      /** Average base-currency change per month across that window. */
      netPerMonth: Decimal;
    };

export function runway(projection: Projection): Runway {
  const exhausted = projection.points.findIndex((point) => point.balance.lessThanOrEqualTo(0));
  if (exhausted !== -1) {
    // Guaranteed present: `findIndex` returned an index into this array.
    const point = projection.points[exhausted] as ProjectedPoint;
    return { kind: 'exhausted', month: point.month, monthsFromNow: exhausted };
  }
  const months = projection.points.length;
  const last = projection.points.at(-1);
  const net = last ? last.balance.minus(projection.opening) : new Decimal(0);
  return {
    kind: 'lasts',
    beyondMonths: months,
    netPerMonth: months > 0 ? net.dividedBy(months) : new Decimal(0),
  };
}

export interface Affordability {
  /** The lowest the balance gets. `month` null when that is the opening balance. */
  lowest: { month: string | null; balance: Decimal };
  /** The balance never goes below zero across the window. */
  affordable: boolean;
  runwayBefore: Runway;
  runwayAfter: Runway;
  /**
   * Months of runway the outflow costs. `null` when that cannot be stated as a
   * number of months — because neither walk runs out inside the window, or
   * because only one of them does, in which case the honest thing is the two
   * answers rather than a difference between incomparable ones.
   */
  monthsLost: number | null;
}

export function affordability(before: Projection, after: Projection): Affordability {
  const runwayBefore = runway(before);
  const runwayAfter = runway(after);

  let lowest: { month: string | null; balance: Decimal } = { month: null, balance: after.opening };
  for (const point of after.points) {
    if (point.balance.lessThan(lowest.balance)) {
      lowest = { month: point.month, balance: point.balance };
    }
  }

  const monthsLost =
    runwayBefore.kind === 'exhausted' && runwayAfter.kind === 'exhausted'
      ? runwayBefore.monthsFromNow - runwayAfter.monthsFromNow
      : null;

  return { lowest, affordable: !lowest.balance.lessThan(0), runwayBefore, runwayAfter, monthsLost };
}

/**
 * What the window comes to, per currency, on each side — for the figures above
 * the chart and the disclosures `<ConvertedTotal>` prints under them.
 */
export function windowTotals(buckets: readonly MonthBucket[]): {
  outflow: Map<string, Decimal>;
  inflow: Map<string, Decimal>;
} {
  const outflow = new Map<string, Decimal>();
  const inflow = new Map<string, Decimal>();
  for (const bucket of buckets) {
    for (const [currencyTokenId, amount] of bucket.outflow) {
      outflow.set(currencyTokenId, (outflow.get(currencyTokenId) ?? new Decimal(0)).plus(amount));
    }
    for (const [currencyTokenId, amount] of bucket.inflow) {
      inflow.set(currencyTokenId, (inflow.get(currencyTokenId) ?? new Decimal(0)).plus(amount));
    }
  }
  return { outflow, inflow };
}
