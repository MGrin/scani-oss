import { and, eq } from 'drizzle-orm';
import Container, { Service } from 'typedi';
import { db } from '../database/connection';
import * as schema from '../database/schema';
import { withTransaction } from '../database/transaction';
import { TokenPriceRepository } from '../repositories/TokenPriceRepository';
import { UserPortfolioEventService } from '../services/UserPortfolioEventService';
import { createComponentLogger } from '../utils/logger';

const logger = createComponentLogger('use-case:update-holding');

export interface UpdateHoldingInput {
  balance?: string;
  lastUpdated?: Date;
  isActive?: boolean;
}

export interface UpdateHoldingOptions {
  baseCurrencyId?: string;
}

/**
 * Use case for updating an existing holding
 *
 * This use case:
 * - Validates holding ownership
 * - Updates holding data with proper timestamp handling
 * - Creates portfolio event for balance changes
 * - Returns the updated holding
 */
@Service()
export class UpdateHoldingUseCase {
  private readonly tokenPriceRepository = Container.get(TokenPriceRepository);
  private readonly userPortfolioEventService = Container.get(UserPortfolioEventService);

  async execute(
    holdingId: string,
    data: UpdateHoldingInput,
    userId: string,
    options?: UpdateHoldingOptions
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
    const updatedHolding = await withTransaction(
      async (tx) => {
        const updateData = {
          ...data,
          lastUpdated: data.lastUpdated || new Date(),
        };

        const [result] = await tx
          .update(schema.holdings)
          .set(updateData)
          .where(and(eq(schema.holdings.id, holdingId), eq(schema.holdings.userId, userId)))
          .returning();

        if (!result) {
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
            holdingId: result.id,
            accountId: result.accountId,
            tokenId: result.tokenId,
            balance: result.balance,
          },
          'Holding updated successfully'
        );

        return result;
      },
      {
        name: 'update-holding',
        timeout: 10000,
      }
    );

    // Create portfolio event for balance change (best-effort, non-blocking)
    // Only create event if balance was changed and baseCurrencyId is provided
    if (data.balance !== undefined && options?.baseCurrencyId) {
      try {
        // Get token and account info for the event
        const [token] = await db
          .select()
          .from(schema.tokens)
          .where(eq(schema.tokens.id, updatedHolding.tokenId))
          .limit(1);

        const [account] = await db
          .select()
          .from(schema.accounts)
          .where(eq(schema.accounts.id, updatedHolding.accountId))
          .limit(1);

        if (token && account) {
          const latestPrice = await this.tokenPriceRepository.findLatestPrice(
            updatedHolding.tokenId,
            options.baseCurrencyId
          );

          await this.userPortfolioEventService.createHoldingUpdateEvent({
            userId,
            holdingId: updatedHolding.id,
            accountId: updatedHolding.accountId,
            institutionId: account.institutionId,
            tokenId: updatedHolding.tokenId,
            tokenSymbol: token.symbol,
            tokenName: token.name,
            balance: updatedHolding.balance,
            price: latestPrice?.price || '0',
            baseCurrencyId: options.baseCurrencyId,
            timestamp: updatedHolding.lastUpdated,
            source: 'holding_update',
          });

          logger.debug(
            { holdingId: updatedHolding.id, tokenSymbol: token.symbol },
            'Created holding_update portfolio event'
          );
        }
      } catch (eventError) {
        logger.warn(
          { holdingId: updatedHolding.id, error: eventError },
          'Failed to create portfolio event for holding update'
        );
        // Event creation failure is non-blocking
      }
    }

    return updatedHolding;
  }
}
