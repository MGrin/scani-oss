import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { withTransaction } from '@scani/db/transaction';
import { createComponentLogger } from '@scani/logging';
import { and, eq } from 'drizzle-orm';
import Container, { Service } from 'typedi';
import { VaultService } from '../services';

const logger = createComponentLogger('use-case:update-holding');

export interface UpdateHoldingInput {
  balance?: string;
  lastUpdated?: Date;
  isActive?: boolean;
}

export interface UpdateHoldingOptions {
  baseCurrencyId?: string;
}

@Service()
export class UpdateHoldingUseCase {
  private readonly vaultService = Container.get(VaultService);

  async execute(
    holdingId: string,
    data: UpdateHoldingInput,
    userId: string,
    options?: UpdateHoldingOptions
  ): Promise<typeof schema.holdings.$inferSelect> {
    logger.debug({ userId, holdingId, data }, 'Updating holding');

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
      { name: 'update-holding', timeout: 10000 }
    );

    if (data.balance !== undefined && options?.baseCurrencyId) {
      // Best-effort portfolio-event side channel — kept here in case the
      // event-emit lands in a future iteration; failure is non-blocking.
      try {
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
      }
    }

    try {
      await this.vaultService.recalculateVaultsForHolding(holdingId);
    } catch (vaultError) {
      logger.warn(
        { holdingId, error: vaultError },
        'Failed to recalculate vaults after holding update'
      );
    }

    return updatedHolding;
  }
}
