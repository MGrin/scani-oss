import { z } from 'zod';
import { movementOutflowRefusesInternal } from '../lib/holding-movement';
import { manualOutflowDestinationSchema } from './transfer-review';

/**
 * The wire shape of "record what I did" (SC-607).
 *
 * A discriminated union rather than one object with optional fields, because
 * the fields are not optional — they are required by exactly one direction
 * each, and an object that lets a caller send `destination` on an inflow is an
 * object whose validity has to be re-checked in the handler.
 */

/**
 * How much MOVED — always positive, whichever way.
 *
 * The sign is carried by the direction, not by the number, and that is the
 * whole ergonomic point of the ticket: an owner recording a withdrawal types
 * `2000`, not `-2000` and not the balance it leaves behind. A negative amount
 * is refused rather than absolved, because "outflow of -2000" has two readings
 * and one of them silently doubles the money.
 *
 * A string, like every other quantity on this wire: `Decimal` is the project's
 * numeric type and a JSON number would round a 14-decimal crypto balance on
 * the way in.
 */
const movementAmount = z
  .string()
  .trim()
  .min(1)
  .refine((value) => /^\d+(\.\d+)?$/.test(value), {
    message: 'Amount must be a positive decimal — the direction carries the sign',
  })
  .refine((value) => Number.parseFloat(value) > 0, {
    message: 'Amount must be greater than zero — a movement of nothing is not a movement',
  });

/**
 * When the money moved, per the owner, ISO-8601.
 *
 * A full instant rather than a calendar date, and that distinction is
 * load-bearing rather than pedantic. A date-only value becomes local midnight,
 * which in a UTC+12 timezone is BEFORE an observation recorded earlier the
 * same day — and a flow dated before the interval it is meant to explain
 * leaves that interval unexplained, which manufactures exactly the review
 * prompt this feature exists to remove. Measured by SC-606 on this repo:
 * 3 prompts with a same-day prior observation, 2 with a 72-hour-old one.
 *
 * So the client sends the actual instant when the owner leaves the date alone,
 * and only a deliberately chosen other day becomes that day's midnight.
 */
const movementOccurredAt = z.string().datetime({ offset: true });

/** Free text the owner attaches. Never parsed, only shown back. */
const movementNote = z.string().trim().max(500).optional();

const movementBase = {
  holdingId: z.string().uuid(),
  amount: movementAmount,
  occurredAt: movementOccurredAt,
  note: movementNote,
};

export const RecordHoldingMovementDto = z.discriminatedUnion('direction', [
  z.object({ ...movementBase, direction: z.literal('inflow') }),
  z.object({
    ...movementBase,
    direction: z.literal('outflow'),
    /**
     * Where it went. Required, with no default on any token type.
     *
     * `manualOutflowDestinationSchema` verbatim (SC-606) rather than a second
     * enum of the same strings, minus `internal` — which is not a narrowing of
     * the vocabulary but a statement about which DIRECTION can express it
     * truthfully here. See `movementOutflowRefusesInternal`.
     */
    destination: manualOutflowDestinationSchema.refine(
      (value) => !movementOutflowRefusesInternal(value),
      {
        message:
          'Money moved to another account you hold is the `transfer` direction — it writes both legs, where `internal` would leave the destination balance untouched',
      }
    ),
  }),
  z.object({
    ...movementBase,
    direction: z.literal('transfer'),
    /**
     * The account the money went to. Resolved by the client through
     * `batchOperations.ensureAccount`, which is the same idempotent
     * find-or-create the manual-entry flow already uses — so "type a name and
     * it is made on the spot" needs no second creation path here.
     */
    destinationAccountId: z.string().uuid(),
    /**
     * The specific holding inside it, when the owner picked one.
     *
     * Optional because an account may hold no position in this token yet —
     * a freshly created one holds none at all — and refusing that would send
     * the owner off to create a holding by hand and come back, which is the
     * friction this ticket removes. Omitted means find-or-create.
     */
    destinationHoldingId: z.string().uuid().optional(),
    /**
     * How much of `amount` the rail kept (SC-889).
     *
     * The same field, spelled the same way, as `manualOutflowAnswerSchema`
     * carries for the balance editor — one wire vocabulary for one concept, so
     * a grep for `feeQuantity` finds every surface a fee can be stated on.
     *
     * On the `transfer` variant ALONE, which is this union's own discipline
     * rather than a narrowing: `inflow` has no second leg for a fee to be the
     * difference between, and `outflow` says the money left the portfolio, so
     * there is nothing for a charge to be carved out of that is still ours. It
     * sits beside `destination` on an inflow — a field the union already
     * declines to give a direction that cannot mean it.
     *
     * Carved OUT of `amount`, never added beside it: the source books
     * `amount - feeQuantity` as the withdrawal and `feeQuantity` as its own
     * `kind='fee'` row, the two summing to the delta the anchor moved by, and
     * the destination receives `amount - feeQuantity` because that is what
     * arrived. See SC-857's design record.
     *
     * Not checked against `amount` here even though both are visible, because
     * `ManualBalanceEditService` refuses a fee that consumes the whole
     * movement through `feeFitsMovement` and its message names both figures.
     * A third spelling of one rule is a third thing free to disagree with the
     * other two.
     */
    feeQuantity: z
      .string()
      .trim()
      .refine((value) => /^\d+(\.\d+)?$/.test(value) && Number.parseFloat(value) > 0, {
        message: 'A fee needs an amount greater than zero',
      })
      .optional(),
  }),
]);

export type RecordHoldingMovementInput = z.infer<typeof RecordHoldingMovementDto>;

/** What the owner gets told happened. */
export interface RecordHoldingMovementResult {
  holdingId: string;
  /** The balance after, so the sheet can show the consequence it computed. */
  balance: string;
  /** Set only for a transfer: the other leg's holding, created or found. */
  destinationHoldingId: string | null;
  destinationBalance: string | null;
  /** Set only for a transfer: the pair both legs now share. */
  transferGroupId: string | null;
}
