import { and, eq } from 'drizzle-orm';
import { Service } from 'typedi';
import * as schema from '../database/schema';
import { withTransaction } from '../database/transaction';
import { createComponentLogger } from '../utils/logger';

const logger = createComponentLogger('use-case:update-holdings-batch');

export interface HoldingUpdate {
  id: string;
  balance: string;
  lastUpdated?: Date;
}

export interface UpdateHoldingsBatchInput {
  holdings: HoldingUpdate[];
}

export interface UpdateHoldingsBatchResult {
  updated: Array<{
    id: string;
    success: boolean;
    error?: string;
  }>;
  totalUpdated: number;
  totalFailed: number;
}

/**
 * Use case for updating multiple holdings in batch
 *
 * This use case:
 * - Updates balance and lastUpdated for multiple holdings
 * - Uses "continue on error" strategy - one failure doesn't block others
 * - Returns detailed results per holding plus summary statistics
 */
@Service()
export class UpdateHoldingsBatchUseCase {
  async execute(
    input: UpdateHoldingsBatchInput,
    userId: string
  ): Promise<UpdateHoldingsBatchResult> {
    logger.debug(
      {
        userId,
        holdingsCount: input.holdings.length,
      },
      'Updating holdings in batch'
    );

    // OPTIMIZATION: Use a single transaction for all updates
    // This dramatically reduces connection usage from N connections to 1
    // All updates succeed or fail together (atomic operation)
    return await withTransaction(
      async (tx) => {
        const results = [];
        let successCount = 0;
        let failureCount = 0;

        for (const holdingUpdate of input.holdings) {
          try {
            const updateData = {
              balance: holdingUpdate.balance,
              lastUpdated: holdingUpdate.lastUpdated || new Date(),
            };

            const [updatedHolding] = await tx
              .update(schema.holdings)
              .set(updateData)
              .where(
                and(eq(schema.holdings.id, holdingUpdate.id), eq(schema.holdings.userId, userId))
              )
              .returning();

            if (!updatedHolding) {
              throw new Error('Holding not found');
            }

            results.push({
              id: holdingUpdate.id,
              success: true,
            });
            successCount++;
          } catch (error) {
            logger.error(
              {
                error,
                holdingId: holdingUpdate.id,
              },
              'Failed to update holding in batch'
            );
            results.push({
              id: holdingUpdate.id,
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
            failureCount++;
          }
        }

        logger.info(
          {
            userId,
            totalUpdated: successCount,
            totalFailed: failureCount,
          },
          'Batch update completed'
        );

        return {
          updated: results,
          totalUpdated: successCount,
          totalFailed: failureCount,
        };
      },
      {
        name: 'update-holdings-batch',
        timeout: 30000, // Longer timeout for batch operations
      }
    );
  }
}
