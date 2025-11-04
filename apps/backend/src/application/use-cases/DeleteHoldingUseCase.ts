import { and, eq } from 'drizzle-orm';
import { Service } from 'typedi';
import { db } from '../../infrastructure/database/connection';
import * as schema from '../../infrastructure/database/schema';
import { createComponentLogger } from '../../utils/logger';

const logger = createComponentLogger('use-case:delete-holding');

export interface DeleteHoldingResult {
  success: boolean;
  deleted: typeof schema.holdings.$inferSelect;
  wasHidden: boolean; // Indicates if the holding was marked as hidden instead of deleted
}

/**
 * Use case for deleting a holding
 *
 * This use case:
 * - Validates holding ownership
 * - For blockchain-sourced holdings: marks them as hidden (soft delete)
 * - For manually created holdings: permanently deletes them
 * - Returns deletion information
 *
 * Blockchain holdings are marked as hidden instead of deleted because they
 * are automatically recreated by the cron job that syncs wallet balances.
 * Hidden holdings are still updated by the cron but excluded from queries.
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

    // First, fetch the holding to check its source
    const [holding] = await db
      .select()
      .from(schema.holdings)
      .where(and(eq(schema.holdings.id, holdingId), eq(schema.holdings.userId, userId)))
      .limit(1);

    if (!holding) {
      logger.warn(
        {
          userId,
          holdingId,
        },
        'Holding not found for deletion'
      );
      throw new Error('Holding not found');
    }

    // If the holding is from blockchain, mark as hidden instead of deleting
    if (holding.source === 'blockchain') {
      await db
        .update(schema.holdings)
        .set({
          isHidden: true,
        })
        .where(eq(schema.holdings.id, holdingId));

      logger.info(
        {
          holdingId: holding.id,
          accountId: holding.accountId,
          tokenId: holding.tokenId,
          source: holding.source,
        },
        'Blockchain holding marked as hidden'
      );

      return {
        success: true,
        deleted: holding,
        wasHidden: true,
      };
    }

    // For manual holdings, permanently delete
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
        source: deletedHolding.source,
      },
      'Manual holding deleted successfully'
    );

    return {
      success: true,
      deleted: deletedHolding,
      wasHidden: false,
    };
  }
}
