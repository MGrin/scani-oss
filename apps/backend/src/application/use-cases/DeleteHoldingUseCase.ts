import { and, eq } from 'drizzle-orm';
import { Service } from 'typedi';
import { db } from '../../infrastructure/database/connection';
import * as schema from '../../infrastructure/database/schema';
import { createComponentLogger } from '../../utils/logger';

const logger = createComponentLogger('use-case:delete-holding');

export interface DeleteHoldingResult {
  success: boolean;
  deleted: typeof schema.holdings.$inferSelect;
}

/**
 * Use case for deleting a holding
 *
 * This use case:
 * - Validates holding ownership
 * - Deletes the holding
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

    // Delete the holding
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
      },
      'Holding deleted successfully'
    );

    return {
      success: true,
      deleted: deletedHolding,
    };
  }
}
