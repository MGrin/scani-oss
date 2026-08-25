import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { NewPayment, Payment } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { Service } from 'typedi';

// The recurring-definition side of the payments layer — one row per
// "Netflix, £12.99/month" or "salary, every other Friday". The dated,
// stateful instances a rule expands into live in
// `PaymentOccurrenceRepository`.
@Service()
export class PaymentRepository extends BaseRepository<Payment, NewPayment> {
  protected readonly table = schema.payments;
  protected readonly tableName = 'payments';

  /**
   * Ownership-scoped single-row lookup — mirrors
   * `AccountRepository.findByIdAndUser`. Returns null when the payment
   * doesn't exist OR belongs to a different user; callers must not
   * distinguish the two cases, since `paymentId` is a client-supplied
   * tRPC input and doing so would let one user probe for another's ids.
   */
  async findByIdAndUser(
    paymentId: string,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<Payment | null> {
    try {
      const database = this.getDb(transaction);
      const [payment] = await database
        .select()
        .from(schema.payments)
        .where(and(eq(schema.payments.id, paymentId), eq(schema.payments.userId, userId)))
        .limit(1);
      return payment ?? null;
    } catch (error) {
      this.logger.error({ paymentId, userId, error }, 'Failed to find payment by id+user');
      throw error;
    }
  }

  async findByUser(userId: string, transaction?: DatabaseTransaction): Promise<Payment[]> {
    try {
      const database = this.getDb(transaction);
      return await database
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.userId, userId))
        .orderBy(schema.payments.createdAt);
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to find payments by user');
      throw error;
    }
  }

  /**
   * Every active payment across every user whose furthest materialised
   * due date falls short of where it should reach today (SC-622).
   *
   * Selecting rather than sweeping all of them is what keeps the nightly
   * roll proportional to the drift: `materialiseSchedule` regenerates a
   * payment's whole history from its own anchor, so re-running it over a
   * book that is already current is a full-table rewrite that inserts
   * nothing.
   *
   * The target edge is `LEAST(horizon, end_date)`, not the horizon: a
   * payment that ends in March can never have rows in December, and
   * comparing it against the horizon alone would pick it every night
   * forever to generate nothing. Only `active` is considered — a paused
   * payment's edge deliberately stops advancing until `resume`, and an
   * ended one must not have its schedule grow back.
   */
  async findActiveNeedingHorizonRoll(
    horizonEnd: string,
    transaction?: DatabaseTransaction
  ): Promise<Payment[]> {
    try {
      const database = this.getDb(transaction);
      const edges = database
        .select({
          paymentId: schema.paymentOccurrences.paymentId,
          maxDueDate: sql<string>`MAX(${schema.paymentOccurrences.dueDate})`.as('max_due_date'),
        })
        .from(schema.paymentOccurrences)
        .groupBy(schema.paymentOccurrences.paymentId)
        .as('edges');

      const rows = await database
        .select({ payment: schema.payments })
        .from(schema.payments)
        .leftJoin(edges, eq(edges.paymentId, schema.payments.id))
        .where(
          and(
            eq(schema.payments.status, 'active'),
            // Composed with `or()` rather than written as one `sql` fragment.
            // A raw `A IS NULL OR A < B` inside `and()` renders unparenthesised,
            // AND binds tighter than OR, and the whole lifecycle filter is then
            // attached to only the first branch — so every payment in the
            // database with a short edge is selected, paused and ended
            // included. `or()` parenthesises itself.
            or(
              isNull(edges.maxDueDate),
              sql`${edges.maxDueDate} < LEAST(${horizonEnd}::date, COALESCE(${schema.payments.endDate}, ${horizonEnd}::date))`
            )
          )
        )
        .orderBy(asc(schema.payments.createdAt));

      return rows.map((row) => row.payment);
    } catch (error) {
      this.logger.error({ horizonEnd, error }, 'Failed to find payments needing a horizon roll');
      throw error;
    }
  }
}
