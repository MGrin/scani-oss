import { and, eq } from 'drizzle-orm';
import { Service } from 'typedi';
import { db } from '../../infrastructure/database/connection';
import * as schema from '../../infrastructure/database/schema';
import { createComponentLogger } from '../../utils/logger';

const logger = createComponentLogger('use-case:delete-holding');

export interface DeleteHoldingResult {
  success: boolean;
  deleted: typeof schema.holdings.$inferSelect;
  cascadeInfo: {
    transactionsDeleted: number;
  };
}

/**
 * Use case for deleting a holding
 *
 * This use case:
 * - Validates holding ownership
 * - Tracks cascade deletion of related transactions
 * - Deletes the holding (cascade deletes will handle transactions)
 * - Returns deletion information
 */
@Service()
export class DeleteHoldingUseCase {
  async execute(holdingId: string, userId: string): Promise<DeleteHoldingResult> {
    logger.debug(
      {
        userId,
        holdingId,
      },
      'Deleting holding'
    );

    // Get transaction count for logging purposes before deletion
    const transactions = await db
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .where(eq(schema.transactions.holdingId, holdingId));

    const transactionCount = transactions.length;

    // Delete the holding - cascading deletes will handle transactions
    const [deletedHolding] = await db
      .delete(schema.holdings)
      .where(and(eq(schema.holdings.id, holdingId), eq(schema.holdings.userId, userId)))
      .returning();

    if (!deletedHolding) {
      logger.warn(
        {
          userId,
          holdingId,
        },
        'Holding not found for deletion'
      );
      throw new Error('Holding not found');
    }

    logger.info(
      {
        holdingId: deletedHolding.id,
        accountId: deletedHolding.accountId,
        tokenId: deletedHolding.tokenId,
        transactionsDeleted: transactionCount,
      },
      'Holding deleted successfully with cascade'
    );

    return {
      success: true,
      deleted: deletedHolding,
      cascadeInfo: {
        transactionsDeleted: transactionCount,
      },
    };
  }
}
