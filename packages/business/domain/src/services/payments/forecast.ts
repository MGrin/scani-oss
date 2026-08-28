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
 *
 * ## Estimating from history (SC-625)
 *
 * SC-461 refused to guess an amount for a variable payment that has none, and
 * that refusal stands: a payment is priced from history only when its owner has
 * said so, per payment, via `estimateFromHistory`. Default off, and a payment
 * carrying the flag with no settled occurrence behind it is STILL unprojectable
 * — the opt-in is permission to use history, not a promise that history exists.
 *
 * **The source is the most recently SETTLED occurrence, not last calendar
 * month.** `matched` with a non-null `actualAmount` is the pair every write
 * path produces together (`ReconcilePaymentsUseCase` and the settle mutation
 * both set them in one act), so it is a discriminator true by construction
 * rather than a correlation. "Last month" has no referent for a quarterly bill;
 * the last settled period is on the payment's own cadence, so nothing here ever
 * annualises, and a quarterly water bill is never projected at a third of
 * itself.
 *
 * **Every movement carries `basis`,** and it is required rather than optional
 * with a `'declared'` default. An optional field compiles at every existing
 * construction site and silently leaves them on the old behaviour; a required
 * one makes the type checker enumerate the places a projection is built, which
 * is the only enumeration that cannot be truncated or defeated by an aliased
 * import.
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
  /**
   * SC-625. Its owner has said this payment may be priced from its own settled
   * history when it has no estimate. Required, not optional-with-a-default:
   * every caller has to state which answer this book gives.
   */
  estimateFromHistory: boolean;
}

export interface ForecastOccurrenceRow {
  dueDate: string;
  /** `'scheduled'` | `'matched'` | `'missed'` | `'skipped'`. */
  status: string;
  expectedAmount: string | null;
  /** What actually moved. Non-null only on a settled row — see `lastSettled`. */
  actualAmount: string | null;
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
   * Where the DATE came from. `materialised` is a real row — it may carry an
   * amount the rule would not produce. `rule` is expanded past the
   * materialised edge and exists only in this answer.
   */
  origin: 'materialised' | 'rule';
  /**
   * Where the AMOUNT came from, which is a different question from `origin`
   * and the one a reader is owed. `declared` is a figure somebody entered —
   * the payment's estimate, or an amount edited onto one occurrence.
   * `history` is this payment's own last settled amount, standing in under
   * SC-625's opt-in: a claim resting on a further claim, and it must never
   * reach a surface wearing the same clothes as a declared figure.
   */
  basis: 'declared' | 'history';
}

/** A payment that is running and has no amount anybody could project. */
export interface UnprojectablePayment {
  paymentId: string;
  direction: ForecastDirection;
  /**
   * The settlement SC-625's opt-in would price this payment from, or `null`
   * when it has none — reported whether or not the option is on.
   *
   * Without it the surface can count these payments but cannot tell which of
   * them turning the option on would actually change, so "use last month's
   * actual for all 3" is offered over a set where it silently does nothing for
   * some. That is the same defect as agreeing to a sentence about N payments
   * and changing N+1, in the direction nobody checks: the reader taps, the
   * count drops by less than the sentence implied, and nothing says why.
   *
   * It is computed for every unprojectable payment rather than only for
   * opted-in ones, because the question it answers — *could* this be
   * estimated — is asked precisely by the payments that are not.
   */
  lastSettled: { amount: string; dueDate: string } | null;
}

/**
 * A payment priced from its own settled history under SC-625's opt-in, with
 * the settlement it was priced from named.
 *
 * The source is carried rather than left for the surface to look up, because
 * the surface's whole job here is to CITE it — "from July's £84.20". A figure
 * that says where it came from cannot be mistaken for a fixed bill, which has
 * nothing to cite; that provenance is the third visual register, and it works
 * even for a reader who ignores every badge on the screen.
 */
export interface HistoryEstimatedPayment {
  paymentId: string;
  direction: ForecastDirection;
  currencyTokenId: string;
  /** The settled amount now standing in as the estimate. */
  amount: string;
  /** `YYYY-MM-DD`, the due date of the settlement it came from. */
  sourceDueDate: string;
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
  /**
   * Payments whose figures in this forecast came from history rather than from
   * a declared estimate (SC-625).
   *
   * Reported beside `unprojectable`, never folded into it: they are two
   * different denominators answering two different questions — what this
   * projection could not price at all, and what it priced on the reader's own
   * say-so. One line doing both jobs would let a book with everything
   * estimated read the same as a book with everything declared.
   */
  estimatedFromHistory: HistoryEstimatedPayment[];
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
 * The most recently settled occurrence, or `null` when nothing has settled.
 *
 * `matched` AND a non-null `actualAmount`, and the conjunction is not belt and
 * braces. `matched` alone admits a row somebody linked to a transaction
 * without recording what moved; `actualAmount` alone would admit a `skipped`
 * row that once carried a figure, which is a decision NOT to pay and the worst
 * possible basis for projecting the next one.
 *
 * Latest by DUE DATE rather than by `updatedAt`: the question is which period
 * this figure describes, and correcting March's bill in August does not make it
 * a better guide to September than July's.
 */
function lastSettled(
  occurrences: readonly ForecastOccurrenceRow[]
): { amount: string; dueDate: string } | null {
  let best: { amount: string; dueDate: string } | null = null;
  for (const occurrence of occurrences) {
    if (occurrence.status !== 'matched' || occurrence.actualAmount === null) continue;
    if (best === null || occurrence.dueDate > best.dueDate) {
      best = { amount: occurrence.actualAmount, dueDate: occurrence.dueDate };
    }
  }
  return best;
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
  const estimatedFromHistory: HistoryEstimatedPayment[] = [];

  const horizonDate = parseUtc(horizonEnd);

  for (const { payment, occurrences } of inputs) {
    // The pause constraint, and the end of a payment's life. Both states keep
    // their rows; neither is a commitment. See the module doc.
    if (payment.status !== 'active') continue;

    const direction = asDirection(payment.direction);

    if (!isProjectableCadence(payment)) {
      // `lastSettled: null` even when this payment HAS settled history, and
      // that is not a shortcut. What is missing here is the DATES, not the
      // amount — nothing can expand a cadence nobody recognises — so offering
      // the option would be offering a button that cannot work. This is the
      // one unprojectable payment SC-625 has no answer for, and it stays
      // counted with no remedy attached.
      unprojectable.push({ paymentId: payment.id, direction, lastSettled: null });
      continue;
    }

    let priced = false;
    let unpriced = false;
    let usedHistory = false;

    // Read once per payment, whatever the flag says — an unprojectable
    // payment has to report whether history EXISTS so the surface can offer
    // the option only where it would do something. What the flag gates is the
    // USE of it below, so a payment with the option off still projects exactly
    // as it did before SC-625.
    const settled = lastSettled(occurrences);
    const useHistory = payment.estimateFromHistory ? settled : null;

    const add = (dueDate: string, amount: string | null, origin: ForecastMovement['origin']) => {
      // The substitution happens HERE, at the one place an amount becomes a
      // movement, rather than by rewriting `payment.expectedAmount` further up.
      // A payment whose estimate was filled in halfway through the window keeps
      // its declared figure on the dates that have one and takes history only
      // on the dates that do not — and every movement can still say which it
      // was, which a pre-substituted amount could not.
      const basis: ForecastMovement['basis'] =
        amount === null && useHistory ? 'history' : 'declared';
      const resolved = basis === 'history' && useHistory ? useHistory.amount : amount;

      if (resolved === null) {
        unpriced = true;
        return;
      }
      priced = true;
      if (basis === 'history') usedHistory = true;
      const movement: ForecastMovement = {
        paymentId: payment.id,
        dueDate,
        direction,
        currencyTokenId: payment.currencyTokenId,
        amount: resolved,
        origin,
        basis,
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
    //
    // SC-625 does not weaken this. A payment carrying the opt-in with no
    // settled occurrence behind it reaches here with `settled === null`, so it
    // is still unpriced and still counted — the option is permission to use
    // history, not a claim that history exists.
    if (unpriced && !priced) {
      unprojectable.push({ paymentId: payment.id, direction, lastSettled: settled });
    }

    // `useHistory`, not `settled`. They hold the same value whenever
    // `usedHistory` is true, so this is correct either way today — and that is
    // the reason to write the one that cannot come apart. A later gate added
    // to `useHistory` would leave the `settled` version reporting an amount
    // the projection did not use, silently, with every test still green.
    if (usedHistory && useHistory) {
      estimatedFromHistory.push({
        paymentId: payment.id,
        direction,
        currencyTokenId: payment.currencyTokenId,
        amount: useHistory.amount,
        sourceDueDate: useHistory.dueDate,
      });
    }
  }

  movements.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  overdue.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  return { movements, overdue, unprojectable, estimatedFromHistory };
}

/** The month bucket a date falls in, `YYYY-MM`. */
export function monthKey(dueDate: string): string {
  return dueDate.slice(0, 7);
}
