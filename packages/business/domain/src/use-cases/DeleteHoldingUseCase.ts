import * as schema from '@scani/db/schema';
import { withTransaction } from '@scani/db/transaction';
import { createComponentLogger } from '@scani/logging';
import { and, eq } from 'drizzle-orm';
import Container, { Service } from 'typedi';
import { VaultRepository } from '../repositories/VaultRepository';
import { VaultService } from '../services';

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
  private readonly vaultRepository = Container.get(VaultRepository);
  private readonly vaultService = Container.get(VaultService);

  async execute(
    holdingId: string,
    userId: string,
    _options?: DeleteHoldingOptions
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
}
