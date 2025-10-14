import { and, eq } from 'drizzle-orm';
import { Service } from 'typedi';
import { db } from '../../infrastructure/database/connection';
import * as schema from '../../infrastructure/database/schema';
import { createComponentLogger } from '../../utils/logger';

const logger = createComponentLogger('use-case:update-holding');

export interface UpdateHoldingInput {
  balance?: string;
  lastUpdated?: Date;
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

    const updateData = {
      ...data,
      lastUpdated: data.lastUpdated || new Date(),
    };

    const [updatedHolding] = await db
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
  }
}
