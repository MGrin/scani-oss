import {
  generateOccurrences,
  type RecurrenceIntervalUnit,
  type RecurrenceStatus,
} from './recurrence';

/**
 * The forward half of the payments model: what a book of recurring payments
 * says will move, dated, between today and a horizon.
 *
 * Pure — no clock, no DB, no DI, same as `./recurrence.ts`, and for the same
 * reason: every rule below is a claim about somebody's money that has to be
 * assertable without a database standing up.
 *
 * ## Why this is not `payments.upcoming` with a bigger `days`
 *
 * `payments.upcoming` reads MATERIALISED `payment_occurrences` rows, and the
 * forward edge of that table decays. `PaymentService` fills it to
 * `MATERIALISATION_HORIZON_MONTHS` (12) past *the day the payment was last
 * written*, and no scheduled job re-materialises — nothing in
 * `packages/business/jobs/src/scheduled-jobs/` calls `materialise`. So a rent
 * payment created five months ago and untouched since has rows seven months
 * out, not twelve, and a twelve-month projection built on that table alone
 * tapers to zero at a different month per payment. The taper looks exactly
 * like a book of costs ending, which is the most reassuring way for a
 * forecast to be wrong.
 *
 * So this reads BOTH: materialised rows where they exist, because they carry
 * decisions the rule does not know about (an edited amount, a skip), and the
 * recurrence rule strictly past each payment's own materialised edge, because
 * that is the only thing that knows the schedule continues.
 *
 * ## Paused payments (SC-47, SC-48)
 *
 * A paused payment KEEPS its future `scheduled` occurrence rows — `pause`
 * writes `status` and `pausedAt` and deliberately deletes nothing, so that
 * `resume` can read the shape of the pause rather than guess it. Which means
 * a projection that reads the occurrence table without looking at the owning
 * payment's status projects every paused bill at full value, with rows in the
 * database to back it up. Filtering on `payment.status === 'active'` is the
 * whole of the fix and it is one line; it is written out here because the
 * failure is invisible from the occurrence rows themselves.
 */

export interface ForecastPayment {
  id: string;
  /** `'inflow'` | `'outflow'`. A bare string on the wire and in the column. */
  direction: string;
  currencyTokenId: string;
  expectedAmount: string | null;
  intervalUnit: string;
  intervalCount: number;
  /** `YYYY-MM-DD`. */
  anchorDate: string;
  /** `'active'` | `'paused'` | `'ended'`. */
  status: string;
  endDate: string | null;
}

export interface ForecastOccurrenceRow {
  dueDate: string;
  /** `'scheduled'` | `'matched'` | `'missed'` | `'skipped'`. */
  status: string;
  expectedAmount: string | null;
}

export interface ForecastPaymentInput {
  payment: ForecastPayment;
  occurrences: readonly ForecastOccurrenceRow[];
}

export type ForecastDirection = 'inflow' | 'outflow';

export interface ForecastMovement {
  paymentId: string;
  /** `YYYY-MM-DD`. */
  dueDate: string;
  direction: ForecastDirection;
  currencyTokenId: string;
  /** A positive magnitude. Direction is a field, never a sign. */
  amount: string;
  /**
   * Where the date came from. `materialised` is a real row — it may carry an
   * amount the rule would not produce. `rule` is expanded past the
   * materialised edge and exists only in this answer.
   */
  origin: 'materialised' | 'rule';
}

/** A payment that is running and has no amount anybody could project. */
export interface UnprojectablePayment {
  paymentId: string;
  direction: ForecastDirection;
}

export interface Forecast {
  /** Due strictly on or after `today`, sorted by date. */
  movements: ForecastMovement[];
  /**
   * Scheduled occurrences already past due. Kept OUT of the series and
   * reported separately: `splitByDueness` in the frontend's `lib/money.ts`
   * settled that a forward window must not absorb money that was already
   * supposed to have left (SC-77). A projection is the same shape of claim,
   * one axis further out.
   */
  overdue: ForecastMovement[];
  unprojectable: UnprojectablePayment[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function parseUtc(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function asDirection(value: string): ForecastDirection {
  return value === 'inflow' ? 'inflow' : 'outflow';
}

/**
 * `generateOccurrences` refuses to expand anything it does not recognise as a
 * cadence, and a projection is arithmetic — a payment nobody can expand is
 * reported as unprojectable rather than silently dropped or guessed at.
 */
const INTERVAL_UNITS: readonly string[] = ['week', 'month', 'quarter', 'year'];

function isProjectableCadence(payment: ForecastPayment): boolean {
  return INTERVAL_UNITS.includes(payment.intervalUnit) && payment.intervalCount > 0;
}

/**
 * What the book says will move between `today` and `horizonEnd`, inclusive at
 * both ends.
 *
 * Every payment that is running contributes either movements or an entry in
 * `unprojectable` — never neither. That is the property the surface's "N
 * payments could not be projected" line rests on, and it is why an amount
 * that cannot be resolved returns a row here instead of a `continue`.
 */
export function buildForecast(
  inputs: readonly ForecastPaymentInput[],
  today: string,
  horizonEnd: string
): Forecast {
  const movements: ForecastMovement[] = [];
  const overdue: ForecastMovement[] = [];
  const unprojectable: UnprojectablePayment[] = [];

  const horizonDate = parseUtc(horizonEnd);

  for (const { payment, occurrences } of inputs) {
    // The pause constraint, and the end of a payment's life. Both states keep
    // their rows; neither is a commitment. See the module doc.
    if (payment.status !== 'active') continue;

    const direction = asDirection(payment.direction);

    if (!isProjectableCadence(payment)) {
      unprojectable.push({ paymentId: payment.id, direction });
      continue;
    }

    let priced = false;
    let unpriced = false;

    const add = (dueDate: string, amount: string | null, origin: ForecastMovement['origin']) => {
      if (amount === null) {
        unpriced = true;
        return;
      }
      priced = true;
      const movement: ForecastMovement = {
        paymentId: payment.id,
        dueDate,
        direction,
        currencyTokenId: payment.currencyTokenId,
        amount,
        origin,
      };
      (dueDate < today ? overdue : movements).push(movement);
    };

    // 1. The rows that exist. `scheduled` only: `matched` is money that has
    //    already moved, `skipped` is a decision not to pay, and `missed` is a
    //    date that went by. None of the three is a future obligation.
    for (const occurrence of occurrences) {
      if (occurrence.status !== 'scheduled') continue;
      if (occurrence.dueDate > horizonEnd) continue;
      add(occurrence.dueDate, occurrence.expectedAmount ?? payment.expectedAmount, 'materialised');
    }

    // 2. The rule, strictly past this payment's own materialised edge. The
    //    edge is the max over EVERY row, not just the scheduled ones — a
    //    settled row still proves the table was filled to that date, and
    //    taking the max over scheduled rows alone would regenerate a date
    //    that is already sitting there as `skipped`.
    const materialisedEdge = occurrences.reduce<string | null>(
      (max, occurrence) => (max === null || occurrence.dueDate > max ? occurrence.dueDate : max),
      null
    );

    const ruleFrom =
      materialisedEdge === null
        ? parseUtc(today)
        : new Date(
            Math.max(parseUtc(materialisedEdge).getTime() + DAY_MS, parseUtc(today).getTime())
          );

    if (ruleFrom.getTime() <= horizonDate.getTime()) {
      const generated = generateOccurrences(
        {
          intervalUnit: payment.intervalUnit as RecurrenceIntervalUnit,
          intervalCount: payment.intervalCount,
          anchorDate: parseUtc(payment.anchorDate),
          status: payment.status as RecurrenceStatus,
          endDate: payment.endDate ? parseUtc(payment.endDate) : null,
          expectedAmount: payment.expectedAmount,
        },
        ruleFrom,
        horizonDate
      );
      for (const candidate of generated) {
        add(toDateString(candidate.dueDate), candidate.expectedAmount, 'rule');
      }
    }

    // Reported when the payment produced no priced movement at all. A
    // variable payment whose estimate was filled in halfway through the
    // window is projected for the part it can be, and saying it is
    // unprojectable would be a claim about the whole of it.
    if (unpriced && !priced) {
      unprojectable.push({ paymentId: payment.id, direction });
    }
  }

  movements.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  overdue.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  return { movements, overdue, unprojectable };
}

/** The month bucket a date falls in, `YYYY-MM`. */
export function monthKey(dueDate: string): string {
  return dueDate.slice(0, 7);
}
