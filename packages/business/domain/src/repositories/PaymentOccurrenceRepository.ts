import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { NewPaymentOccurrence, PaymentOccurrence } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, asc, eq, gte } from 'drizzle-orm';
import { Service } from 'typedi';

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
}
