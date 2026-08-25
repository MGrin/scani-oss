import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { NewPaymentOccurrence, PaymentOccurrence } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, asc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import { Service } from 'typedi';
// Type-only, so nothing links the repository to the service at runtime. The
// alternative is a second declaration of the same five fields, and the shape
// the reminder reads is exactly the shape this query has to produce.
import type { DueOccurrence } from '../services/payments/PaymentReminderService';

/** A `DueOccurrence` plus the name the digest prints beside it (SC-460). */
export interface UpcomingOccurrence extends DueOccurrence {
  vendorName: string;
}

// The materialised, stateful side of the payments layer — one row per
// dated instance a `payments` recurrence rule expands into. See the
// module doc on `../services/payments/recurrence.ts` for why these
// can't be computed on the fly: matched/skipped/missed status and an
// actual amount attach to a SPECIFIC due date, not to the rule.
@Service()
export class PaymentOccurrenceRepository extends BaseRepository<
  PaymentOccurrence,
  NewPaymentOccurrence
> {
  protected readonly table = schema.paymentOccurrences;
  protected readonly tableName = 'payment_occurrences';

  /**
   * Insert candidate occurrences, silently skipping any that already
   * exist for `(payment_id, due_date)`. This is what makes
   * `PaymentService.materialise` safe to re-run on every edit and on a
   * schedule without ever double-writing a due date.
   */
  async bulkUpsert(
    rows: NewPaymentOccurrence[],
    transaction?: DatabaseTransaction
  ): Promise<PaymentOccurrence[]> {
    if (rows.length === 0) return [];
    try {
      const database = this.getDb(transaction);
      return await database
        .insert(schema.paymentOccurrences)
        .values(rows)
        .onConflictDoNothing({
          target: [schema.paymentOccurrences.paymentId, schema.paymentOccurrences.dueDate],
        })
        .returning();
    } catch (error) {
      this.logger.error({ count: rows.length, error }, 'Failed to bulk-upsert payment occurrences');
      throw error;
    }
  }

  /**
   * Ownership-scoped single-row lookup. `payment_occurrences` has no
   * `userId` of its own — ownership is join-derived through `payments`
   * — so this can't reuse `BaseRepository.findById` the way
   * `PaymentRepository.findByIdAndUser` does. Same precedent though:
   * `occurrenceId` is a client-supplied tRPC input, and returning null
   * for both "doesn't exist" and "belongs to someone else" is what
   * stops one user from probing for another's ids.
   */
  async findByIdAndUser(
    occurrenceId: string,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<PaymentOccurrence | null> {
    try {
      const database = this.getDb(transaction);
      const [row] = await database
        .select({ occurrence: schema.paymentOccurrences })
        .from(schema.paymentOccurrences)
        .innerJoin(schema.payments, eq(schema.paymentOccurrences.paymentId, schema.payments.id))
        .where(
          and(eq(schema.paymentOccurrences.id, occurrenceId), eq(schema.payments.userId, userId))
        )
        .limit(1);
      return row?.occurrence ?? null;
    } catch (error) {
      this.logger.error({ occurrenceId, userId, error }, 'Failed to find occurrence by id+user');
      throw error;
    }
  }

  /**
   * The single occurrence sitting on one exact due date. Not
   * ownership-scoped on its own — `(payment_id, due_date)` is unique, so
   * callers must have already proved they own `paymentId` (the way
   * `findByPaymentId` requires, for the same reason).
   */
  async findByPaymentIdAndDueDate(
    paymentId: string,
    dueDate: string,
    transaction?: DatabaseTransaction
  ): Promise<PaymentOccurrence | null> {
    try {
      const database = this.getDb(transaction);
      const [row] = await database
        .select()
        .from(schema.paymentOccurrences)
        .where(
          and(
            eq(schema.paymentOccurrences.paymentId, paymentId),
            eq(schema.paymentOccurrences.dueDate, dueDate)
          )
        )
        .limit(1);
      return row ?? null;
    } catch (error) {
      this.logger.error({ paymentId, dueDate, error }, 'Failed to find occurrence by payment+date');
      throw error;
    }
  }

  async findByPaymentId(
    paymentId: string,
    transaction?: DatabaseTransaction
  ): Promise<PaymentOccurrence[]> {
    try {
      const database = this.getDb(transaction);
      return await database
        .select()
        .from(schema.paymentOccurrences)
        .where(eq(schema.paymentOccurrences.paymentId, paymentId))
        .orderBy(asc(schema.paymentOccurrences.dueDate));
    } catch (error) {
      this.logger.error({ paymentId, error }, 'Failed to find occurrences by payment');
      throw error;
    }
  }

  /**
   * Every occurrence of several payments at once.
   *
   * `findByPaymentId` in a `Promise.all` is what `payments.upcoming` does, and
   * it is one round trip per payment. The forecast needs the WHOLE table for
   * every active payment — it has to find each one's materialised edge, which
   * no date filter can be applied before — so on a book of thirty payments
   * that shape is thirty queries for one figure.
   */
  async findByPaymentIds(
    paymentIds: readonly string[],
    transaction?: DatabaseTransaction
  ): Promise<PaymentOccurrence[]> {
    if (paymentIds.length === 0) return [];
    try {
      const database = this.getDb(transaction);
      return await database
        .select()
        .from(schema.paymentOccurrences)
        .where(inArray(schema.paymentOccurrences.paymentId, [...paymentIds]))
        .orderBy(asc(schema.paymentOccurrences.dueDate));
    } catch (error) {
      this.logger.error(
        { count: paymentIds.length, error },
        'Failed to find occurrences by payments'
      );
      throw error;
    }
  }

  /**
   * Propagate an amount change to occurrences that haven't happened yet
   * AND haven't been touched. `status = 'scheduled'` excludes
   * matched/missed/skipped rows regardless of date, and
   * `dueDate >= fromDate` excludes anything already in the past. This
   * is the only write path allowed to mutate an occurrence's expected
   * amount post-materialisation — history stays immutable.
   */
  async updateFutureScheduledAmount(
    paymentId: string,
    fromDate: string,
    expectedAmount: string | null,
    transaction?: DatabaseTransaction
  ): Promise<PaymentOccurrence[]> {
    try {
      const database = this.getDb(transaction);
      return await database
        .update(schema.paymentOccurrences)
        .set({ expectedAmount, updatedAt: new Date() })
        .where(
          and(
            eq(schema.paymentOccurrences.paymentId, paymentId),
            eq(schema.paymentOccurrences.status, 'scheduled'),
            gte(schema.paymentOccurrences.dueDate, fromDate)
          )
        )
        .returning();
    } catch (error) {
      this.logger.error(
        { paymentId, fromDate, error },
        'Failed to update future scheduled occurrence amounts'
      );
      throw error;
    }
  }

  /**
   * Record the due dates a pause covered as deliberately skipped.
   *
   * `[fromDate, beforeDate)` — half-open, because `beforeDate` is the day
   * the pause ended and that day is active again, so an occurrence due on
   * it is live rather than skipped (which is what makes pausing and
   * resuming on the same day a true no-op).
   *
   * `status = 'scheduled'` is the whole safety property: a row the user
   * already matched, skipped or missed carries a decision and is never
   * overwritten here — same rule `deleteAllScheduled` and
   * `updateFutureScheduledAmount` are built on.
   */
  async markScheduledSkippedInRange(
    paymentId: string,
    fromDate: string,
    beforeDate: string,
    transaction?: DatabaseTransaction
  ): Promise<PaymentOccurrence[]> {
    try {
      const database = this.getDb(transaction);
      return await database
        .update(schema.paymentOccurrences)
        .set({ status: 'skipped', updatedAt: new Date() })
        .where(
          and(
            eq(schema.paymentOccurrences.paymentId, paymentId),
            eq(schema.paymentOccurrences.status, 'scheduled'),
            gte(schema.paymentOccurrences.dueDate, fromDate),
            lt(schema.paymentOccurrences.dueDate, beforeDate)
          )
        )
        .returning();
    } catch (error) {
      this.logger.error(
        { paymentId, fromDate, beforeDate, error },
        'Failed to mark paused-through occurrences skipped'
      );
      throw error;
    }
  }

  /**
   * Remove not-yet-happened, untouched occurrences from `fromDate`
   * onward. Used when a payment's schedule shape changes (interval,
   * anchor, end date) so stale rows computed under the OLD rule don't
   * sit next to the newly materialised ones — `bulkUpsert` only ever
   * adds rows, so this is the only thing that can retire a wrong one.
   * Matched/missed/skipped rows are never touched.
   */
  /**
   * Every `scheduled` row for a payment, regardless of date.
   *
   * A `scheduled` occurrence carries NO user decision — no settlement, no
   * skip, no invoice link, no amount the user typed. It is derived
   * entirely from the recurrence rule, so a shape change can regenerate
   * it losslessly. Rows that DO carry a decision (`matched`, `skipped`,
   * `missed`) are untouched here and remapped separately.
   *
   * Bounding this by date is what left duplicated PAST unpaid rows: the
   * delete spared them while `materialiseSchedule` — which starts at the
   * payment's own anchor, not today — inserted the new rule's past dates
   * alongside. A monthly bill moved from the 1st to the 3rd then showed
   * two overdue rows per month.
   */
  async deleteAllScheduled(
    paymentId: string,
    transaction?: DatabaseTransaction
  ): Promise<PaymentOccurrence[]> {
    try {
      const database = this.getDb(transaction);
      return await database
        .delete(schema.paymentOccurrences)
        .where(
          and(
            eq(schema.paymentOccurrences.paymentId, paymentId),
            eq(schema.paymentOccurrences.status, 'scheduled')
          )
        )
        .returning();
    } catch (error) {
      this.logger.error({ paymentId, error }, 'Failed to delete scheduled payment occurrences');
      throw error;
    }
  }

  async deleteScheduledOnOrAfter(
    paymentId: string,
    fromDate: string,
    transaction?: DatabaseTransaction
  ): Promise<PaymentOccurrence[]> {
    try {
      const database = this.getDb(transaction);
      return await database
        .delete(schema.paymentOccurrences)
        .where(
          and(
            eq(schema.paymentOccurrences.paymentId, paymentId),
            eq(schema.paymentOccurrences.status, 'scheduled'),
            gte(schema.paymentOccurrences.dueDate, fromDate)
          )
        )
        .returning();
    } catch (error) {
      this.logger.error(
        { paymentId, fromDate, error },
        'Failed to delete scheduled occurrences on or after date'
      );
      throw error;
    }
  }

  /**
   * Everything one user still owes on a single calendar day (SC-226).
   *
   * One joined query rather than `findByUser` + a `findByPaymentId` per
   * payment, which is what `payments.upcoming` does. That composition is right
   * for a request serving one user; this runs on the worker for every
   * subscribed user on every hourly fire, and the per-payment fan-out would
   * make the cost of the reminder scale with how many bills the whole
   * userbase has rather than with how many are due.
   *
   * Four filters, each of which changes what the notification would say:
   *
   * - **`direction = 'outflow'`.** The ask is "whether to move money tonight"
   *   (SC-226), so incoming money is not part of it. Netting salary against
   *   rent would produce a number that is true and useless.
   * - **`status = 'scheduled'`.** A `matched` occurrence has already been
   *   paid, and `skipped`/`missed` were settled deliberately. Reminding
   *   someone to pay a bill they paid this morning is how a reminder loses
   *   its authority.
   * - **`payments.status = 'active'`.** A paused payment keeps its future
   *   occurrences on purpose (see `PaymentService`), so filtering on the
   *   occurrence alone would remind about bills the user has stopped.
   * - **the exact due date**, computed in the USER's zone by the caller. A
   *   range would silently re-include today's overdue items, which is a
   *   different and unrequested notification.
   *
   * The amount coalesces the occurrence's own value over the payment's
   * estimate, matching how the Money screen reads it: a variable bill whose
   * real amount arrived keeps that amount, and one that never got an estimate
   * stays null and is COUNTED but never summed.
   */
  async findDueOnDateForUser(
    userId: string,
    dueDate: string,
    transaction?: DatabaseTransaction
  ): Promise<DueOccurrence[]> {
    try {
      const database = this.getDb(transaction);
      return await database
        .select({
          occurrenceId: schema.paymentOccurrences.id,
          dueDate: schema.paymentOccurrences.dueDate,
          expectedAmount: sql<
            string | null
          >`coalesce(${schema.paymentOccurrences.expectedAmount}, ${schema.payments.expectedAmount})`,
          currencyTokenId: schema.payments.currencyTokenId,
          currencySymbol: schema.tokens.symbol,
        })
        .from(schema.paymentOccurrences)
        .innerJoin(schema.payments, eq(schema.paymentOccurrences.paymentId, schema.payments.id))
        .innerJoin(schema.tokens, eq(schema.payments.currencyTokenId, schema.tokens.id))
        .where(
          and(
            eq(schema.payments.userId, userId),
            eq(schema.payments.status, 'active'),
            eq(schema.payments.direction, 'outflow'),
            eq(schema.paymentOccurrences.status, 'scheduled'),
            eq(schema.paymentOccurrences.dueDate, dueDate)
          )
        );
    } catch (error) {
      this.logger.error({ userId, dueDate, error }, 'Failed to load occurrences due on date');
      throw error;
    }
  }

  /**
   * Everything one user owes across a DATE RANGE, vendor included (SC-460).
   *
   * Sibling of `findDueOnDateForUser` above rather than a parameter on it, and
   * the note there says why: that method takes an exact date deliberately,
   * because widening it to a range would silently re-include today's overdue
   * items in a push that promises tomorrow's. The digest is the other case —
   * it is explicitly "what is coming", so a range is what it means, and the
   * two callers should not have to agree about which mode they are in.
   *
   * Carries `vendorName` because the digest names bills and the push counts
   * them: "Rent and 2 others" is a reason to open the mail, "3 payments due"
   * is not.
   */
  async findDueBetweenForUser(
    userId: string,
    fromDate: string,
    toDate: string,
    transaction?: DatabaseTransaction
  ): Promise<UpcomingOccurrence[]> {
    try {
      const database = this.getDb(transaction);
      return await database
        .select({
          occurrenceId: schema.paymentOccurrences.id,
          dueDate: schema.paymentOccurrences.dueDate,
          expectedAmount: sql<
            string | null
          >`coalesce(${schema.paymentOccurrences.expectedAmount}, ${schema.payments.expectedAmount})`,
          currencyTokenId: schema.payments.currencyTokenId,
          currencySymbol: schema.tokens.symbol,
          vendorName: schema.vendors.displayName,
        })
        .from(schema.paymentOccurrences)
        .innerJoin(schema.payments, eq(schema.paymentOccurrences.paymentId, schema.payments.id))
        .innerJoin(schema.tokens, eq(schema.payments.currencyTokenId, schema.tokens.id))
        .innerJoin(schema.vendors, eq(schema.payments.vendorId, schema.vendors.id))
        .where(
          and(
            eq(schema.payments.userId, userId),
            eq(schema.payments.status, 'active'),
            eq(schema.payments.direction, 'outflow'),
            eq(schema.paymentOccurrences.status, 'scheduled'),
            gte(schema.paymentOccurrences.dueDate, fromDate),
            lte(schema.paymentOccurrences.dueDate, toDate)
          )
        )
        .orderBy(asc(schema.paymentOccurrences.dueDate));
    } catch (error) {
      this.logger.error(
        { userId, fromDate, toDate, error },
        'Failed to load occurrences due between dates'
      );
      throw error;
    }
  }
}
