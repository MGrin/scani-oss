import type { DatabaseTransaction } from '@scani/db';
import type {
  Payment,
  PaymentDirection,
  PaymentIntervalUnit,
  PaymentKind,
  PaymentOccurrence,
  PaymentOrigin,
} from '@scani/db/schema';
import { Decimal } from '@scani/shared';
import { Container, Service } from 'typedi';
import { AccountRepository } from '../../repositories/AccountRepository';
import { PaymentOccurrenceRepository } from '../../repositories/PaymentOccurrenceRepository';
import { PaymentRepository } from '../../repositories/PaymentRepository';
import { VendorRepository } from '../../repositories/VendorRepository';
import {
  generateOccurrences,
  type RecurrenceIntervalUnit,
  type RecurrenceSchedule,
  type RecurrenceStatus,
} from './recurrence';
import { planSettledRemap } from './remapSettledOccurrences';

// How far past "now" `materialise` fills the FORWARD edge of the window
// on every call. Only the forward edge is rolling — see
// `materialiseSchedule` for why the back edge is fixed at the payment's
// own `anchorDate` instead of also rolling with "now".
const MATERIALISATION_HORIZON_MONTHS = 12;

// Fields that change WHICH due dates a recurrence rule produces. Editing
// any of these invalidates previously materialised future `scheduled`
// rows (their dates no longer match the rule); editing anything else
// (e.g. just the amount) does not.
const SCHEDULE_SHAPE_FIELDS = ['intervalUnit', 'intervalCount', 'anchorDate', 'endDate'] as const;

export interface CreatePaymentInput {
  vendorId: string;
  direction: PaymentDirection;
  kind: PaymentKind;
  expectedAmount?: string | null;
  currencyTokenId: string;
  intervalUnit: PaymentIntervalUnit;
  intervalCount: number;
  anchorDate: string; // 'YYYY-MM-DD'
  endDate?: string | null;
  accountId?: string | null;
  notes?: string | null;
  // Where this payment came from. Defaults to the column's own 'manual'
  // when omitted; `CreatePaymentFromExtractionUseCase` passes 'document'.
  origin?: PaymentOrigin;
}

// The user (or the reconcile job, for the automated path) resolving an
// occurrence. `matchedTransactionId` / `matchedExtractionId` are both
// optional and, when omitted, leave whatever was already there
// untouched — see `settleOccurrence` for why that matters: a manual "yes
// I paid this" re-confirmation must not silently unlink a transaction an
// earlier auto-match already tied, nor the invoice the occurrence was
// settled from in the first place.
export interface SettleOccurrenceInput {
  status: 'matched' | 'skipped';
  actualAmount?: string | null;
  matchedTransactionId?: string | null;
  matchedExtractionId?: string | null;
}

/** The occurrences a delete would take with it, by what they mean. */
export interface PaymentDeleteImpact {
  /** Dates the rule produced and nobody has answered yet. Lossless to drop. */
  scheduled: number;
  /** `matched` — money that really moved. Any at all blocks the delete. */
  settled: number;
  /** `skipped` — a decision not to pay. Discarded, and named in the sentence. */
  skipped: number;
}

/**
 * Raised when a payment has settled occurrences and someone asked to delete
 * it rather than end it.
 *
 * The two operations are different claims and SC-83 keeps them apart.
 * `end` says "this bill really ran and has now stopped": the record and its
 * history survive, and every figure that ever counted it still counts it.
 * `delete` says "this should never have existed" — a mistyped amount, a
 * duplicate from an invoice, a test — so the record goes and the figures
 * lose it.
 *
 * A `matched` occurrence is the one thing that makes the second claim
 * false. It is money that moved, carrying the transaction it was matched
 * against and the invoice it was settled from; deleting the payment
 * cascades it away and rewrites the vendor's paid totals for a period the
 * reader is not being asked about. So the refusal points at `end`, which is
 * the operation that actually fits a bill that has run.
 *
 * `skipped` does NOT block. A deliberate "not this month" on a payment that
 * should never have existed is a decision about a mistake, and no money is
 * described by it — but it is still a decision, so the count is named in
 * the confirmation rather than discarded quietly.
 */
export class PaymentHasSettledOccurrencesError extends Error {
  constructor(readonly settledCount: number) {
    super(
      `Payment has ${settledCount} settled occurrence${settledCount === 1 ? '' : 's'} and cannot be deleted`
    );
    this.name = 'PaymentHasSettledOccurrencesError';
  }
}

export interface UpdatePaymentInput {
  vendorId?: string;
  direction?: PaymentDirection;
  kind?: PaymentKind;
  expectedAmount?: string | null;
  currencyTokenId?: string;
  intervalUnit?: PaymentIntervalUnit;
  intervalCount?: number;
  anchorDate?: string;
  endDate?: string | null;
  accountId?: string | null;
  notes?: string | null;
}

function startOfUtcToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function addUtcMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate()));
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseUtcDateString(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

// Anything that is neither `scheduled` nor `skipped` counts as settled —
// `matched` today, and `missed`, which the enum has and nothing writes yet.
// The fallthrough is which way to be wrong: an unrecognised status counted
// as settled blocks a delete that might have been fine, while one counted
// as scheduled destroys a row nobody was asked about.
function summariseDeleteImpact(occurrences: readonly { status: string }[]): PaymentDeleteImpact {
  let scheduled = 0;
  let settled = 0;
  let skipped = 0;
  for (const occurrence of occurrences) {
    if (occurrence.status === 'scheduled') scheduled += 1;
    else if (occurrence.status === 'skipped') skipped += 1;
    else settled += 1;
  }
  return { scheduled, settled, skipped };
}

function amountsEqual(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return new Decimal(a).equals(new Decimal(b));
}

// Owns every mutation to a `payments` row plus the operation that turns
// its recurrence rule into dated, statable instances: `materialise`.
//
// Every public method takes and enforces a `userId` — `paymentId` is a
// client-supplied tRPC input, and without the check one user could read
// or rewrite another user's recurring bill by guessing an id (same
// precedent as `VendorRepository.merge`).
@Service()
export class PaymentService {
  private readonly paymentRepository = Container.get(PaymentRepository);
  private readonly occurrenceRepository = Container.get(PaymentOccurrenceRepository);
  private readonly vendorRepository = Container.get(VendorRepository);
  private readonly accountRepository = Container.get(AccountRepository);

  async create(
    userId: string,
    input: CreatePaymentInput,
    transaction?: DatabaseTransaction
  ): Promise<Payment> {
    await this.assertVendorOwnership(userId, input.vendorId, transaction);
    await this.assertAccountOwnership(userId, input.accountId, transaction);

    const payment = await this.paymentRepository.create(
      {
        userId,
        vendorId: input.vendorId,
        direction: input.direction,
        kind: input.kind,
        expectedAmount: input.expectedAmount ?? null,
        currencyTokenId: input.currencyTokenId,
        intervalUnit: input.intervalUnit,
        intervalCount: input.intervalCount,
        anchorDate: input.anchorDate,
        endDate: input.endDate ?? null,
        accountId: input.accountId ?? null,
        notes: input.notes ?? null,
        ...(input.origin ? { origin: input.origin } : {}),
      },
      transaction
    );

    await this.materialiseSchedule(payment, transaction);
    return payment;
  }

  async update(
    userId: string,
    paymentId: string,
    input: UpdatePaymentInput,
    transaction?: DatabaseTransaction
  ): Promise<Payment> {
    const existing = await this.requireOwned(userId, paymentId, transaction);
    if (input.vendorId !== undefined) {
      await this.assertVendorOwnership(userId, input.vendorId, transaction);
    }
    if (input.accountId !== undefined) {
      await this.assertAccountOwnership(userId, input.accountId, transaction);
    }

    const amountChanged =
      input.expectedAmount !== undefined &&
      !amountsEqual(input.expectedAmount, existing.expectedAmount);
    const scheduleShapeChanged = SCHEDULE_SHAPE_FIELDS.some(
      (field) => input[field] !== undefined && input[field] !== existing[field]
    );

    const updated = await this.paymentRepository.update(paymentId, { ...input }, transaction);
    if (!updated) {
      throw new Error(`Payment ${paymentId} disappeared during update`);
    }

    const today = toDateString(startOfUtcToday());
    if (scheduleShapeChanged) {
      const before = await this.occurrenceRepository.findByPaymentId(paymentId, transaction);
      // ALL scheduled rows, not just future ones. A `scheduled` row is
      // derived purely from the rule and carries no decision, so it is
      // lossless to regenerate; bounding the delete at `today` left the
      // old rule's PAST rows in place while `materialiseSchedule` — which
      // starts at the payment's anchor, not today — inserted the new
      // rule's past dates beside them, showing two overdue rows per
      // period. Rows carrying a decision are spared here and remapped
      // below.
      //
      // The delete is unconditional, so the regenerate has to be too —
      // `evenIfPaused` is what keeps the pair balanced for a paused
      // payment, which otherwise came out of this branch with an empty
      // schedule and a success response.
      const removed = await this.occurrenceRepository.deleteAllScheduled(paymentId, transaction);
      const removedIds = new Set(removed.map((row) => row.id));
      await this.remapSettledOccurrences(
        existing,
        updated,
        before.filter((row) => !removedIds.has(row.id)),
        transaction
      );
      await this.materialiseSchedule(updated, transaction, { evenIfPaused: true });
    } else if (amountChanged) {
      await this.occurrenceRepository.updateFutureScheduledAmount(
        paymentId,
        today,
        updated.expectedAmount,
        transaction
      );
    }

    return updated;
  }

  /**
   * Stop the rule producing new due dates, and record WHEN that stopped.
   *
   * Already-materialised rows are deliberately left in place: they are
   * hidden from `payments.upcoming` (which filters to active payments)
   * but they still describe the schedule, and deleting them would make
   * `resume` guess at the shape of the pause instead of reading it.
   * `pausedAt` is the only thing written beyond the status, and it is
   * what makes the pause reversible — see `resume`.
   */
  async pause(
    userId: string,
    paymentId: string,
    transaction?: DatabaseTransaction
  ): Promise<Payment> {
    const existing = await this.requireOwned(userId, paymentId, transaction);
    // Re-pausing must not move the window: the first pause is still the
    // one the elapsed due dates fell inside.
    if (existing.status === 'paused') return existing;

    const updated = await this.paymentRepository.update(
      paymentId,
      { status: 'paused', pausedAt: new Date() },
      transaction
    );
    if (!updated) {
      throw new Error(`Payment ${paymentId} disappeared during pause`);
    }
    return updated;
  }

  /**
   * The inverse of `pause` — and the reason it exists at all: without one,
   * the UI offered an action the user could not undo.
   *
   * The rule this follows is the one `update`/`remapSettledOccurrences`
   * already established: rewrite what the recurrence rule DERIVES, never
   * touch what the user DECIDED. Applied to a pause that spanned due
   * dates, that settles all three candidate meanings of "resume":
   *
   * - The anchor is NOT moved. `anchorDate` is a user decision (rent is
   *   due on the 1st), so restarting "from today" would silently rewrite
   *   every future due date and break the ordinal pairing settled rows
   *   depend on. Resume is not an edit to the schedule.
   * - The elapsed periods are NOT left standing as overdue. A pause is
   *   the user saying "not these" — resurfacing them as debts on resume
   *   would invent an obligation nobody agreed to, which is precisely
   *   what makes backfilling wrong.
   * - They are NOT deleted either, which would make the payment's history
   *   claim the bill did not exist those months. They become `skipped`,
   *   the vocabulary the occurrence model already has for "deliberately
   *   not paid" — and being a decision, they then survive later schedule
   *   edits through `remapSettledOccurrences` like any other.
   *
   * So: the schedule keeps its original dates, the pause window is
   * recorded as skipped, and nothing lands overdue. Due dates that were
   * ALREADY overdue when the pause started keep standing — they fall
   * outside the window and were never part of the pause decision.
   *
   * Resuming an already-active payment is a no-op rather than an error;
   * reviving an `ended` one is a different, larger operation (it would
   * have to unpick `endDate` and the occurrences `end` deleted) and is
   * refused here rather than half-done.
   */
  async resume(
    userId: string,
    paymentId: string,
    transaction?: DatabaseTransaction
  ): Promise<Payment> {
    const existing = await this.requireOwned(userId, paymentId, transaction);
    if (existing.status === 'active') return existing;
    if (existing.status === 'ended') {
      throw new Error(`Payment ${paymentId} has ended and cannot be resumed`);
    }

    const updated = await this.paymentRepository.update(
      paymentId,
      { status: 'active', pausedAt: null },
      transaction
    );
    if (!updated) {
      throw new Error(`Payment ${paymentId} disappeared during resume`);
    }

    // Materialise BEFORE skipping, not after. The horizon stopped
    // advancing when the payment was paused, so a pause longer than
    // MATERIALISATION_HORIZON_MONTHS leaves part of its own window with
    // no rows at all; generating first means those dates exist to be
    // skipped instead of appearing as fresh overdue rows.
    await this.materialiseSchedule(updated, transaction);

    // Null only for rows paused before `paused_at` existed. There is no
    // provable window for those, and inventing one would skip due dates
    // the user never paused through.
    if (existing.pausedAt) {
      await this.occurrenceRepository.markScheduledSkippedInRange(
        paymentId,
        toDateString(existing.pausedAt),
        toDateString(startOfUtcToday()),
        transaction
      );
    }

    return updated;
  }

  async end(
    userId: string,
    paymentId: string,
    endDate?: string,
    transaction?: DatabaseTransaction
  ): Promise<Payment> {
    await this.requireOwned(userId, paymentId, transaction);
    const resolvedEndDate = endDate ?? toDateString(startOfUtcToday());

    // `pausedAt` describes a pause that can still be resumed; ending
    // retires that possibility, so leaving the timestamp behind would
    // only ever be a stale fact.
    const updated = await this.paymentRepository.update(
      paymentId,
      { status: 'ended', endDate: resolvedEndDate, pausedAt: null },
      transaction
    );
    if (!updated) {
      throw new Error(`Payment ${paymentId} disappeared during end`);
    }

    // A row due ON the end date is still expected; anything after it
    // never should have been.
    const afterEnd = toDateString(addUtcDays(parseUtcDateString(resolvedEndDate), 1));
    await this.occurrenceRepository.deleteScheduledOnOrAfter(paymentId, afterEnd, transaction);
    return updated;
  }

  /**
   * What deleting this payment would destroy, so the confirmation can name
   * it. Read off the occurrences themselves rather than estimated: the same
   * rule `end`'s sentence follows, and the counts are what decide whether
   * the delete is allowed at all.
   */
  async deleteImpact(
    userId: string,
    paymentId: string,
    transaction?: DatabaseTransaction
  ): Promise<PaymentDeleteImpact> {
    await this.requireOwned(userId, paymentId, transaction);
    const occurrences = await this.occurrenceRepository.findByPaymentId(paymentId, transaction);
    return summariseDeleteImpact(occurrences);
  }

  /**
   * Remove a payment that should never have existed — distinct from `end`,
   * which retires one that really ran. See
   * `PaymentHasSettledOccurrencesError` for the argument.
   *
   * Every occurrence goes with it: `payment_occurrences.payment_id` is ON
   * DELETE CASCADE, so nothing is orphaned and nothing has to be swept
   * afterwards. The impact is recounted here rather than trusted from a
   * preview, so a settlement that landed while the confirmation was open
   * still blocks the delete.
   *
   * CALLERS SHOULD PASS `transaction` for that recount to mean anything:
   * the count and the delete are two statements, and a settlement
   * committed between them would otherwise be cascaded away by a check
   * that had already passed.
   */
  async delete(
    userId: string,
    paymentId: string,
    transaction?: DatabaseTransaction
  ): Promise<PaymentDeleteImpact> {
    await this.requireOwned(userId, paymentId, transaction);
    const occurrences = await this.occurrenceRepository.findByPaymentId(paymentId, transaction);
    const impact = summariseDeleteImpact(occurrences);
    if (impact.settled > 0) {
      throw new PaymentHasSettledOccurrencesError(impact.settled);
    }
    await this.paymentRepository.delete(paymentId, transaction);
    return impact;
  }

  async materialise(
    userId: string,
    paymentId: string,
    transaction?: DatabaseTransaction
  ): Promise<PaymentOccurrence[]> {
    const payment = await this.requireOwned(userId, paymentId, transaction);
    return this.materialiseSchedule(payment, transaction);
  }

  /**
   * The path that always works — no bank ingestion required. The user
   * (or `ReconcilePaymentsUseCase`, for the Airwallex-only automated
   * path) says an occurrence is paid, optionally with the real amount
   * and the transaction it corresponds to, or explicitly skipped.
   *
   * Idempotent by construction: it's a plain UPDATE keyed on
   * `occurrenceId`, so calling it twice with the same input leaves the
   * same row. Critically, `matchedTransactionId` is only ever written
   * when the caller passes it — omitting it (the normal shape of a
   * manual "yes, paid" from the UI) leaves whatever was already there
   * alone, so re-confirming an auto-matched occurrence can't silently
   * unlink its transaction.
   */
  async settleOccurrence(
    userId: string,
    occurrenceId: string,
    input: SettleOccurrenceInput,
    transaction?: DatabaseTransaction
  ): Promise<PaymentOccurrence> {
    await this.requireOwnedOccurrence(userId, occurrenceId, transaction);

    const patch: Partial<PaymentOccurrence> = { status: input.status };
    if (input.actualAmount !== undefined) {
      patch.actualAmount = input.actualAmount;
    }
    if (input.matchedTransactionId !== undefined) {
      patch.matchedTransactionId = input.matchedTransactionId;
    }
    if (input.matchedExtractionId !== undefined) {
      patch.matchedExtractionId = input.matchedExtractionId;
    }

    const updated = await this.occurrenceRepository.update(occurrenceId, patch, transaction);
    if (!updated) {
      throw new Error(`Payment occurrence ${occurrenceId} disappeared during settle`);
    }
    return updated;
  }

  private async requireOwnedOccurrence(
    userId: string,
    occurrenceId: string,
    transaction?: DatabaseTransaction
  ): Promise<PaymentOccurrence> {
    const occurrence = await this.occurrenceRepository.findByIdAndUser(
      occurrenceId,
      userId,
      transaction
    );
    if (!occurrence) {
      throw new Error(`Payment occurrence ${occurrenceId} not found for user ${userId}`);
    }
    return occurrence;
  }

  private async requireOwned(
    userId: string,
    paymentId: string,
    transaction?: DatabaseTransaction
  ): Promise<Payment> {
    const payment = await this.paymentRepository.findByIdAndUser(paymentId, userId, transaction);
    if (!payment) {
      throw new Error(`Payment ${paymentId} not found for user ${userId}`);
    }
    return payment;
  }

  private async assertVendorOwnership(
    userId: string,
    vendorId: string,
    transaction?: DatabaseTransaction
  ): Promise<void> {
    const vendor = await this.vendorRepository.findById(vendorId, transaction);
    if (!vendor || vendor.userId !== userId) {
      throw new Error(`Cannot use vendor ${vendorId}: not found for user ${userId}`);
    }
  }

  private async assertAccountOwnership(
    userId: string,
    accountId: string | null | undefined,
    transaction?: DatabaseTransaction
  ): Promise<void> {
    if (!accountId) return;
    const account = await this.accountRepository.findByIdAndUser(accountId, userId, transaction);
    if (!account) {
      throw new Error(`Cannot use account ${accountId}: not found for user ${userId}`);
    }
  }

  /**
   * Keep settlements attached to the schedule across a shape change.
   *
   * The nth occurrence of the OLD rule and the nth occurrence of the
   * NEW one are the same real-world period, so a settled row is moved
   * to its ordinal twin's date rather than left on a date the rule no
   * longer generates (which is what stranded it AND let
   * `materialiseSchedule` insert an unpaid duplicate beside it).
   *
   * Runs after the future `scheduled` rows are deleted and before
   * re-materialisation, so the moves land in slots the upsert would
   * otherwise fill, and `onConflictDoNothing` then skips them.
   */
  private async remapSettledOccurrences(
    previous: Payment,
    updated: Payment,
    survivors: PaymentOccurrence[],
    transaction?: DatabaseTransaction
  ): Promise<void> {
    if (!survivors.some((row) => row.status !== 'scheduled')) return;

    const to = this.materialisationHorizonEnd();
    const plan = planSettledRemap(
      survivors,
      this.dueDateSequence(previous, to),
      this.dueDateSequence(updated, to)
    );

    // Displaced rows are all untouched `scheduled` ones and never
    // movers themselves, so clearing them up front cannot break a
    // later move.
    for (const occurrenceId of plan.displacedOccurrenceIds) {
      await this.occurrenceRepository.delete(occurrenceId, transaction);
    }
    for (const move of plan.moves) {
      await this.occurrenceRepository.update(
        move.occurrenceId,
        { dueDate: move.toDueDate, updatedAt: new Date() },
        transaction
      );
    }
  }

  // Index i is the i-th occurrence the rule produces, counted from its
  // own anchor — which is what makes two sequences pairable by index.
  // Asks the rule, not the lifecycle: a paused payment's settled rows
  // have ordinal twins just like an active one's, and two empty
  // sequences would silently pair nothing at all.
  private dueDateSequence(payment: Payment, to: Date): string[] {
    const schedule = this.buildRuleSchedule(payment);
    return generateOccurrences(schedule, schedule.anchorDate, to).map((candidate) =>
      toDateString(candidate.dueDate)
    );
  }

  private materialisationHorizonEnd(): Date {
    return addUtcMonths(startOfUtcToday(), MATERIALISATION_HORIZON_MONTHS);
  }

  private buildSchedule(payment: Payment): RecurrenceSchedule {
    return {
      intervalUnit: payment.intervalUnit as RecurrenceIntervalUnit,
      intervalCount: payment.intervalCount,
      anchorDate: parseUtcDateString(payment.anchorDate),
      status: payment.status as RecurrenceStatus,
      endDate: payment.endDate ? parseUtcDateString(payment.endDate) : null,
      expectedAmount: payment.expectedAmount,
    };
  }

  /**
   * The same recurrence rule with its lifecycle status set aside.
   *
   * `generateOccurrences` expands nothing for a paused schedule, which
   * is the right answer to "should this payment keep gaining due dates?"
   * and the wrong one to "which dates does this rule name?". `update`
   * only ever asks the second question — it has already deleted the rows
   * it is about to replace — and asking the first left a paused payment
   * with its whole schedule deleted and nothing put back.
   */
  private buildRuleSchedule(payment: Payment): RecurrenceSchedule {
    return { ...this.buildSchedule(payment), status: 'active' };
  }

  private async materialiseSchedule(
    payment: Payment,
    transaction?: DatabaseTransaction,
    // Set only by `update`, whose delete-then-regenerate pair is
    // balanced only if the regenerate answers for a paused payment too.
    // Everywhere else the pause must keep doing its job: `materialise`
    // on a paused payment adds nothing, so the horizon stops advancing
    // until `resume` — which flips the status first and so needs no
    // exemption.
    options: { evenIfPaused?: boolean } = {}
  ): Promise<PaymentOccurrence[]> {
    const schedule = options.evenIfPaused
      ? this.buildRuleSchedule(payment)
      : this.buildSchedule(payment);

    // `from` is the payment's own anchor, not "today" — that's the
    // whole reason occurrences are materialised instead of computed on
    // the fly (see the module doc on `./recurrence.ts`): March matched,
    // April missed, May skipped, June's actual differed from expected —
    // none of that is readable if the past was never written. Only the
    // forward edge rolls with "now", which is what makes re-running
    // this on a schedule keep extending the horizon instead of forever
    // regenerating the same 12 months from whenever the payment was
    // created.
    const to = this.materialisationHorizonEnd();
    const candidates = generateOccurrences(schedule, schedule.anchorDate, to);
    if (candidates.length === 0) return [];

    const rows = candidates.map((candidate) => ({
      paymentId: payment.id,
      dueDate: toDateString(candidate.dueDate),
      expectedAmount: candidate.expectedAmount,
    }));

    return this.occurrenceRepository.bulkUpsert(rows, transaction);
  }
}
