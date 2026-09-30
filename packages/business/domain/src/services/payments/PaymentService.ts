import { type DatabaseTransaction, getDb } from '@scani/db';
import type {
  Payment,
  PaymentDirection,
  PaymentIntervalUnit,
  PaymentKind,
  PaymentOccurrence,
  PaymentOrigin,
} from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { Decimal } from '@scani/shared';
import { and, asc, eq, gte, inArray, or } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { AccountRepository } from '../../repositories/AccountRepository';
import { DocumentExtractionRepository } from '../../repositories/DocumentExtractionRepository';
import { HoldingTransactionRepository } from '../../repositories/HoldingTransactionRepository';
import { PaymentOccurrenceRepository } from '../../repositories/PaymentOccurrenceRepository';
import { PaymentRepository } from '../../repositories/PaymentRepository';
import { VendorRepository } from '../../repositories/VendorRepository';
import { PaymentGroupService } from './PaymentGroupService';
import {
  generateOccurrences,
  type RecurrenceIntervalUnit,
  type RecurrenceSchedule,
  type RecurrenceStatus,
} from './recurrence';

// How far past "now" `materialise` fills the FORWARD edge of the window.
// Only the forward edge is rolling — see `materialiseSchedule` for why
// the back edge is fixed at the payment's own `anchorDate` instead of
// also rolling with "now".
//
// "Rolling" is a property of the CALLER, not of this constant. Every
// other materialising path here runs as a side effect of a write, so an
// untouched payment's edge stayed where its last write left it and the
// window shrank by a month every month (SC-622). The nightly
// `RollPaymentHorizonsUseCase` is what makes the word true.
const MATERIALISATION_HORIZON_MONTHS = 12;

// Fields that change WHICH due dates a recurrence rule produces. Editing
// any of these invalidates previously materialised future `scheduled`
// rows (their dates no longer match the rule); editing anything else
// (e.g. just the amount) does not.
const SCHEDULE_SHAPE_FIELDS = ['intervalUnit', 'intervalCount', 'anchorDate', 'endDate'] as const;

export interface CreatePaymentInput {
  groupIds?: string[];
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
  // SC-625's opt-in, off unless the form says otherwise. Optional here and
  // required on `ForecastPayment` for opposite reasons: a caller creating a
  // payment is stating a user's intent and may have none to state, while a
  // caller building a forecast is answering "what does this book do", which
  // has no absent answer.
  estimateFromHistory?: boolean;
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
  groupIds?: string[];
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
  estimateFromHistory?: boolean;
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
  private readonly holdingTransactionRepository = Container.get(HoldingTransactionRepository);
  private readonly extractionRepository = Container.get(DocumentExtractionRepository);
  private readonly paymentGroups = Container.get(PaymentGroupService);

  async groupAssignments(userId: string, transaction?: DatabaseTransaction) {
    const database = transaction ?? getDb();
    const membership = await this.paymentGroups.resolve(userId, transaction);
    const overrides = await database
      .select({
        id: schema.paymentOccurrenceGroups.occurrenceId,
        groupId: schema.paymentOccurrenceGroups.groupId,
      })
      .from(schema.paymentOccurrenceGroups)
      .innerJoin(
        schema.paymentOccurrences,
        eq(schema.paymentOccurrences.id, schema.paymentOccurrenceGroups.occurrenceId)
      )
      .innerJoin(schema.payments, eq(schema.payments.id, schema.paymentOccurrences.paymentId))
      .where(eq(schema.payments.userId, userId));
    const collect = (rows: { id: string; groupId: string }[]) => {
      const result: Record<string, string[]> = {};
      for (const row of rows) {
        const assigned = result[row.id] ?? [];
        assigned.push(row.groupId);
        result[row.id] = assigned;
      }
      return result;
    };
    // `payments` is every group a bill is in; `viaPayee` says which of them
    // only its payee's rule puts it in (SC-1408).
    const payments: Record<string, string[]> = {};
    const viaPayee: Record<string, string[]> = {};
    for (const [paymentId, groups] of membership) {
      payments[paymentId] = [...groups.keys()];
      const ruled = [...groups].filter(([, source]) => source === 'payee').map(([id]) => id);
      if (ruled.length) viaPayee[paymentId] = ruled;
    }
    return {
      payments,
      viaPayee,
      payees: await this.paymentGroups.payeeRules(userId, transaction),
      occurrences: collect(overrides),
    };
  }

  async assignGroups(
    userId: string,
    input: { paymentId: string; occurrenceId?: string; groupIds: string[] },
    transaction?: DatabaseTransaction
  ): Promise<void> {
    if (!transaction) return getDb().transaction((tx) => this.assignGroups(userId, input, tx));
    const [payment] = await transaction
      .select()
      .from(schema.payments)
      .where(and(eq(schema.payments.id, input.paymentId), eq(schema.payments.userId, userId)))
      .for('update');
    if (!payment) throw new Error('Payment not found');
    const ids = [...new Set(input.groupIds)];
    if (ids.length) {
      const owned = await transaction
        .select({ id: schema.groups.id })
        .from(schema.groups)
        .where(and(inArray(schema.groups.id, ids), eq(schema.groups.userId, userId)))
        .for('key share');
      if (owned.length !== ids.length) throw new Error('Group not found');
    }
    if (!input.occurrenceId) {
      await this.paymentGroups.setBillGroups(payment, ids, transaction);
      return;
    }
    const occurrence = await this.requireOwnedOccurrence(userId, input.occurrenceId, transaction);
    if (occurrence.paymentId !== payment.id) throw new Error('Occurrence not found');
    await this.occurrenceRepository.update(occurrence.id, { groupsOverridden: true }, transaction);
    await transaction
      .delete(schema.paymentOccurrenceGroups)
      .where(eq(schema.paymentOccurrenceGroups.occurrenceId, occurrence.id));
    if (ids.length)
      await transaction
        .insert(schema.paymentOccurrenceGroups)
        .values(ids.map((groupId) => ({ occurrenceId: occurrence.id, groupId })));
  }

  async editOccurrence(
    userId: string,
    occurrenceId: string,
    input: { expectedAmount: string | null; groupIds?: string[] },
    transaction?: DatabaseTransaction
  ): Promise<PaymentOccurrence> {
    if (!transaction)
      return getDb().transaction((tx) => this.editOccurrence(userId, occurrenceId, input, tx));
    const occurrence = await this.requireOwnedOccurrence(userId, occurrenceId, transaction);
    if (
      input.expectedAmount !== null &&
      (!new Decimal(input.expectedAmount).isFinite() || new Decimal(input.expectedAmount).lt(0))
    )
      throw new Error('Invalid amount');
    await this.occurrenceRepository.update(
      occurrenceId,
      { expectedAmount: input.expectedAmount, amountOverridden: true },
      transaction
    );
    if (input.groupIds !== undefined)
      await this.assignGroups(
        userId,
        { paymentId: occurrence.paymentId, occurrenceId, groupIds: input.groupIds },
        transaction
      );
    return this.requireOwnedOccurrence(userId, occurrenceId, transaction);
  }

  async create(
    userId: string,
    input: CreatePaymentInput,
    transaction?: DatabaseTransaction
  ): Promise<Payment> {
    if (!transaction) return getDb().transaction((tx) => this.create(userId, input, tx));
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
        estimateFromHistory: input.estimateFromHistory ?? false,
        ...(input.origin ? { origin: input.origin } : {}),
      },
      transaction
    );

    // Groups first: `assignGroups` only tags occurrences from today on, and
    // `materialiseSchedule` gives every row it inserts the payment's groups —
    // so a bill created with past dates gets its groups on those too.
    if (input.groupIds)
      await this.assignGroups(
        userId,
        { paymentId: payment.id, groupIds: input.groupIds },
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
    if (!transaction) return getDb().transaction((tx) => this.update(userId, paymentId, input, tx));
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

    const { groupIds, ...columns } = input;
    const updated = await this.paymentRepository.update(
      paymentId,
      {
        ...columns,
        ...(scheduleShapeChanged ? { scheduleEffectiveFrom: toDateString(startOfUtcToday()) } : {}),
      },
      transaction
    );
    if (!updated) {
      throw new Error(`Payment ${paymentId} disappeared during update`);
    }

    const today = toDateString(startOfUtcToday());
    if (scheduleShapeChanged) {
      const futureScheduled = and(
        eq(schema.paymentOccurrences.paymentId, paymentId),
        eq(schema.paymentOccurrences.status, 'scheduled'),
        gte(schema.paymentOccurrences.dueDate, today)
      );
      const overridden = await transaction
        .select()
        .from(schema.paymentOccurrences)
        .where(
          and(
            futureScheduled,
            or(
              eq(schema.paymentOccurrences.amountOverridden, true),
              eq(schema.paymentOccurrences.groupsOverridden, true)
            )
          )
        )
        .orderBy(asc(schema.paymentOccurrences.dueDate));
      await transaction
        .delete(schema.paymentOccurrences)
        .where(
          and(
            futureScheduled,
            eq(schema.paymentOccurrences.amountOverridden, false),
            eq(schema.paymentOccurrences.groupsOverridden, false)
          )
        );
      await this.materialiseSchedule(updated, transaction, { evenIfPaused: true });
      await this.moveOverridesOntoSchedule(updated, overridden, today, transaction);
    } else if (amountChanged) {
      await this.occurrenceRepository.updateFutureScheduledAmount(
        paymentId,
        today,
        updated.expectedAmount,
        transaction
      );
    }

    if (groupIds) await this.assignGroups(userId, { paymentId, groupIds }, transaction);
    else if (input.vendorId !== undefined && input.vendorId !== existing.vendorId) {
      // An exclusion opts out of the OLD payee's rule, so it says nothing
      // about the new one (SC-1408).
      await transaction
        .delete(schema.paymentGroupExclusions)
        .where(eq(schema.paymentGroupExclusions.paymentId, paymentId));
      await this.paymentGroups.retagFuture(userId, [paymentId], transaction);
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

  /**
   * Fill this payment's occurrences forward to the horizon.
   *
   * Public because the forward edge does not advance by itself. Every
   * other materialising path — `create`, an amount change in `update`,
   * `resume` — runs as a side effect of a WRITE, so a payment nobody
   * touches keeps the edge its last write gave it while "now" moves
   * underneath it. `RollPaymentHorizonsUseCase` calls this nightly for
   * exactly that reason (SC-622); `materialiseSchedule` explains why
   * re-running it costs nothing.
   *
   * Takes the row, not an id, and checks no ownership: the caller is a
   * cross-user sweep that has already loaded the row and has no
   * requester whose claim to it could be checked. Anything reached from
   * a router must resolve the payment through `requireOwned` first.
   */
  async materialise(
    payment: Payment,
    transaction?: DatabaseTransaction
  ): Promise<PaymentOccurrence[]> {
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
   *
   * Both links are checked against the caller before anything is written
   * (SC-1287): the occurrence being yours says nothing about the transaction
   * or extraction you point it at. A foreign id and a nonexistent one get the
   * same refusal, so the answer cannot be used to probe for ids.
   */
  async settleOccurrence(
    userId: string,
    occurrenceId: string,
    input: SettleOccurrenceInput,
    transaction?: DatabaseTransaction
  ): Promise<PaymentOccurrence> {
    await this.requireOwnedOccurrence(userId, occurrenceId, transaction);

    if (input.matchedTransactionId) {
      const matched = await this.holdingTransactionRepository.findById(
        input.matchedTransactionId,
        transaction
      );
      if (matched?.userId !== userId) {
        throw new Error('Matched transaction not found');
      }
    }
    if (input.matchedExtractionId) {
      const extraction = await this.extractionRepository.findByIdAndUser(
        input.matchedExtractionId,
        userId,
        transaction
      );
      if (!extraction) {
        throw new Error('Matched extraction not found');
      }
    }

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
   * The date the forward edge should reach today.
   *
   * Public so the sweep that rolls the edge selects payments against the
   * same bound this fills them to. Two copies of "12 months" — one in the
   * query that decides a payment is behind, one in the generator that
   * catches it up — is a pair that can disagree, and the disagreement
   * would show up as a sweep that either never finishes or never runs.
   */
  materialisationHorizonEnd(): Date {
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

  /**
   * An override belongs to a due date, and a schedule edit can remove that
   * date. Left where it was, the edited occurrence sits beside the new
   * schedule's own date for the same period and the bill falls due twice.
   * It moves to the nearest new date nobody else has claimed, keeping its id
   * and so its group choices; one past the new end date is dropped, because
   * the payment no longer happens then.
   */
  private async moveOverridesOntoSchedule(
    payment: Payment,
    overridden: PaymentOccurrence[],
    today: string,
    transaction: DatabaseTransaction
  ): Promise<void> {
    if (overridden.length === 0) return;
    const scheduled = new Set(
      generateOccurrences(
        this.buildRuleSchedule(payment),
        parseUtcDateString(today),
        this.materialisationHorizonEnd()
      ).map((candidate) => toDateString(candidate.dueDate))
    );
    const unclaimed = new Set(scheduled);
    for (const row of overridden) unclaimed.delete(row.dueDate);
    for (const row of overridden) {
      if (scheduled.has(row.dueDate)) continue;
      const target =
        payment.endDate && row.dueDate > payment.endDate
          ? undefined
          : nearestDate(row.dueDate, unclaimed);
      if (!target) {
        await transaction
          .delete(schema.paymentOccurrences)
          .where(eq(schema.paymentOccurrences.id, row.id));
        continue;
      }
      unclaimed.delete(target);
      await transaction
        .delete(schema.paymentOccurrences)
        .where(
          and(
            eq(schema.paymentOccurrences.paymentId, payment.id),
            eq(schema.paymentOccurrences.dueDate, target),
            eq(schema.paymentOccurrences.status, 'scheduled')
          )
        );
      await transaction
        .update(schema.paymentOccurrences)
        .set({ dueDate: target, updatedAt: new Date() })
        .where(eq(schema.paymentOccurrences.id, row.id));
    }
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
    if (!transaction)
      return getDb().transaction((tx) => this.materialiseSchedule(payment, tx, options));
    const [current] = await transaction
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.id, payment.id))
      .for('update');
    if (!current) return [];
    payment = current;
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
    const from = payment.scheduleEffectiveFrom
      ? parseUtcDateString(payment.scheduleEffectiveFrom)
      : schedule.anchorDate;
    const candidates = generateOccurrences(schedule, from, to);
    if (candidates.length === 0) return [];

    const rows = candidates.map((candidate) => ({
      paymentId: payment.id,
      dueDate: toDateString(candidate.dueDate),
      expectedAmount: candidate.expectedAmount,
    }));

    const inserted = await this.occurrenceRepository.bulkUpsert(rows, transaction);
    await this.paymentGroups.tagOccurrences(payment.userId, inserted, transaction);
    return inserted;
  }
}

function nearestDate(from: string, dates: ReadonlySet<string>): string | undefined {
  const origin = Date.parse(from);
  let best: string | undefined;
  for (const date of [...dates].sort()) {
    if (
      best === undefined ||
      Math.abs(Date.parse(date) - origin) < Math.abs(Date.parse(best) - origin)
    )
      best = date;
  }
  return best;
}
