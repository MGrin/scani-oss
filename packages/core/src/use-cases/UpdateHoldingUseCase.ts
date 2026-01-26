import { and, eq } from 'drizzle-orm';
import { Service } from 'typedi';
import * as schema from '../database/schema';
import { withTransaction } from '../database/transaction';
import { createComponentLogger } from '../utils/logger';

const logger = createComponentLogger('use-case:update-holding');

export interface UpdateHoldingInput {
  balance?: string;
  lastUpdated?: Date;
  isActive?: boolean;
}

/**
 * Use case for updating an existing holding
 *
 * This use case:
 * - Validates holding ownership
 * - Updates holding data with proper timestamp handling
 * - Returns the updated holding
 */
@Service()
export class UpdateHoldingUseCase {
  async execute(
    holdingId: string,
    data: UpdateHoldingInput,
    userId: string
  ): Promise<typeof schema.holdings.$inferSelect> {
    logger.debug(
      {
        userId,
        holdingId,
        data,
      },
      'Updating holding'
    );

    // Use transaction to ensure atomic update
    // Prevents race conditions and ensures consistency
    return await withTransaction(
      async (tx) => {
        const updateData = {
          ...data,
          lastUpdated: data.lastUpdated || new Date(),
        };

        const [updatedHolding] = await tx
          .update(schema.holdings)
          .set(updateData)
          .where(and(eq(schema.holdings.id, holdingId), eq(schema.holdings.userId, userId)))
          .returning();

        if (!updatedHolding) {
          logger.warn(
            {
              userId,
              holdingId,
            },
            'Holding not found for update'
          );
          throw new Error('Holding not found');
        }

        logger.info(
          {
            holdingId: updatedHolding.id,
            accountId: updatedHolding.accountId,
            tokenId: updatedHolding.tokenId,
            balance: updatedHolding.balance,
          },
          'Holding updated successfully'
        );

        return updatedHolding;
      },
      {
        name: 'update-holding',
        timeout: 10000,
      }
    );
  }
}
