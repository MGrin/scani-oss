import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { NewPayment, Payment } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, eq } from 'drizzle-orm';
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
}
