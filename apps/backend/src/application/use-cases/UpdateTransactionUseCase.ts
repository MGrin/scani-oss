import { and, eq } from 'drizzle-orm';
import { Service } from 'typedi';
import { db } from '../../infrastructure/database/connection';
import * as schema from '../../infrastructure/database/schema';
import { createComponentLogger } from '../../utils/logger';

const logger = createComponentLogger('use-case:update-transaction');

// Type for Postgres-like database connection
const routerDb = db as ReturnType<typeof import('drizzle-orm/postgres-js').drizzle>;

export interface UpdateTransactionInput {
  amount?: string;
  fee?: string;
  feeTokenId?: string;
  description?: string;
  reference?: string;
  timestamp?: Date;
}

export interface UpdateTransactionResult {
  id: string;
  holdingId: string;
  typeId: string;
  type: string;
  typeName: string;
  amount: string;
  fee: string;
  feeTokenId: string | null;
  description: string | null;
  reference: string | null;
  timestamp: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Use case for updating an existing transaction
 *
 * This use case:
 * - Validates transaction ownership via holding
 * - Updates transaction data with proper timestamp handling
 * - Fetches and returns the complete updated transaction with type information
 */
@Service()
export class UpdateTransactionUseCase {
  async execute(
    transactionId: string,
    data: UpdateTransactionInput,
    userId: string
  ): Promise<UpdateTransactionResult> {
    logger.debug(
      {
        userId,
        transactionId,
        data,
      },
      'Updating transaction'
    );

    // First verify the transaction belongs to the user by checking holding ownership
    const [transactionOwnership] = await routerDb
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .innerJoin(schema.holdings, eq(schema.transactions.holdingId, schema.holdings.id))
      .where(and(eq(schema.transactions.id, transactionId), eq(schema.holdings.userId, userId)))
      .limit(1);

    if (!transactionOwnership) {
      logger.warn(
        {
          userId,
          transactionId,
        },
        'Transaction not found or does not belong to user'
      );
      throw new Error('Transaction not found');
    }

    const updateData = {
      ...data,
      updatedAt: new Date(),
    };

    const [updatedTransaction] = await routerDb
      .update(schema.transactions)
      .set(updateData)
      .where(eq(schema.transactions.id, transactionId))
      .returning();

    if (!updatedTransaction) {
      logger.error(
        {
          userId,
          transactionId,
        },
        'Failed to update transaction - no data returned'
      );
      throw new Error('Transaction not found');
    }

    // Fetch the updated transaction with type information
    const [transactionWithType] = await routerDb
      .select({
        id: schema.transactions.id,
        holdingId: schema.transactions.holdingId,
        typeId: schema.transactions.typeId,
        type: schema.transactionTypes.code,
        typeName: schema.transactionTypes.name,
        amount: schema.transactions.amount,
        fee: schema.transactions.fee,
        feeTokenId: schema.transactions.feeTokenId,
        description: schema.transactions.description,
        reference: schema.transactions.reference,
        timestamp: schema.transactions.timestamp,
        createdAt: schema.transactions.createdAt,
        updatedAt: schema.transactions.updatedAt,
      })
      .from(schema.transactions)
      .innerJoin(
        schema.transactionTypes,
        eq(schema.transactions.typeId, schema.transactionTypes.id)
      )
      .where(eq(schema.transactions.id, updatedTransaction.id))
      .limit(1);

    if (!transactionWithType) {
      logger.error(
        {
          userId,
          transactionId,
        },
        'Failed to fetch updated transaction with type information'
      );
      throw new Error('Failed to fetch updated transaction');
    }

    logger.info(
      {
        transactionId: transactionWithType.id,
        holdingId: transactionWithType.holdingId,
        type: transactionWithType.type,
        amount: transactionWithType.amount,
      },
      'Transaction updated successfully'
    );

    return transactionWithType;
  }
}
