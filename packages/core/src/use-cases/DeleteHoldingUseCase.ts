import { and, eq } from 'drizzle-orm';
import Container, { Service } from 'typedi';
import { db } from '../database/connection';
import * as schema from '../database/schema';
import { withTransaction } from '../database/transaction';
import { TokenPriceRepository } from '../repositories/TokenPriceRepository';
import { VaultRepository } from '../repositories/VaultRepository';
import { UserPortfolioEventService } from '../services/UserPortfolioEventService';
import { VaultService } from '../services/VaultService';
import { createComponentLogger } from '../utils/logger';

const logger = createComponentLogger('use-case:delete-holding');

export interface DeleteHoldingResult {
  success: boolean;
  deleted: typeof schema.holdings.$inferSelect;
  wasHidden: boolean; // Indicates if the holding was marked as hidden instead of deleted
}

export interface DeleteHoldingOptions {
  baseCurrencyId?: string;
}

/**
 * Use case for deleting a holding
 *
 * This use case:
 * - Validates holding ownership
 * - For blockchain-sourced holdings: marks them as hidden (soft delete)
 * - For manually created holdings: permanently deletes them
 * - Creates portfolio event for the deletion
 * - Returns deletion information
 *
 * Blockchain holdings are marked as hidden instead of deleted because they
 * are automatically recreated by the cron job that syncs wallet balances.
 * Hidden holdings are still updated by the cron but excluded from queries.
 */
@Service()
export class DeleteHoldingUseCase {
  private readonly tokenPriceRepository = Container.get(TokenPriceRepository);
  private readonly userPortfolioEventService = Container.get(UserPortfolioEventService);
  private readonly vaultRepository = Container.get(VaultRepository);
  private readonly vaultService = Container.get(VaultService);

  async execute(
    holdingId: string,
    userId: string,
    options?: DeleteHoldingOptions
  ): Promise<DeleteHoldingResult> {
    logger.debug(
      {
        userId,
        holdingId,
      },
      'Deleting holding'
    );

    // Use transaction to ensure atomicity
    // This prevents race conditions where holding could be modified between fetch and delete/update
    const result = await withTransaction(
      async (tx) => {
        // First, fetch the holding to check its source
        const [holding] = await tx
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
          await tx
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
        const [deletedHolding] = await tx
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
      },
      {
        name: 'delete-holding',
        timeout: 10000,
      }
    );

    // Create portfolio event for deletion (best-effort, non-blocking)
    if (options?.baseCurrencyId) {
      await this.createDeleteEvent(result.deleted, userId, options.baseCurrencyId);
    }

    // Detach from all vaults and recalculate affected vaults (best-effort, non-blocking)
    try {
      const affectedVaultIds = await this.vaultRepository.detachAllHoldingsForHolding(holdingId);
      if (affectedVaultIds.length > 0) {
        await Promise.all(
          affectedVaultIds.map((vaultId) => this.vaultService.recalculateVaultAmount(vaultId))
        );
      }
    } catch (vaultError) {
      logger.warn(
        { holdingId, error: vaultError },
        'Failed to detach/recalculate vaults after holding deletion'
      );
    }

    return result;
  }

  /**
   * Helper to create a delete event after a holding is deleted/hidden
   */
  private async createDeleteEvent(
    holding: typeof schema.holdings.$inferSelect,
    userId: string,
    baseCurrencyId: string
  ): Promise<void> {
    try {
      // Get token and account info for the event
      const [token] = await db
        .select()
        .from(schema.tokens)
        .where(eq(schema.tokens.id, holding.tokenId))
        .limit(1);

      const [account] = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, holding.accountId))
        .limit(1);

      if (token && account) {
        const latestPrice = await this.tokenPriceRepository.findLatestPrice(
          holding.tokenId,
          baseCurrencyId
        );

        await this.userPortfolioEventService.createHoldingDeleteEvent({
          userId,
          holdingId: holding.id,
          accountId: holding.accountId,
          institutionId: account.institutionId,
          tokenId: holding.tokenId,
          tokenSymbol: token.symbol,
          tokenName: token.name,
          balance: '0', // Balance is 0 after deletion
          price: latestPrice?.price || '0',
          baseCurrencyId,
          timestamp: new Date(),
          source: 'holding_delete',
        });

        logger.debug(
          { holdingId: holding.id, tokenSymbol: token.symbol },
          'Created holding_delete portfolio event'
        );
      }
    } catch (eventError) {
      logger.warn(
        { holdingId: holding.id, error: eventError },
        'Failed to create portfolio event for holding deletion'
      );
      // Event creation failure is non-blocking
    }
  }
}
