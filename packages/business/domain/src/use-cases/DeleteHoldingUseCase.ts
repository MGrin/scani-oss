import * as schema from '@scani/db/schema';
import { withTransaction } from '@scani/db/transaction';
import { createComponentLogger } from '@scani/logging';
import { and, eq } from 'drizzle-orm';
import Container, { Service } from 'typedi';
import { VaultRepository } from '../repositories/VaultRepository';
import { VaultService } from '../services';
import { holdingKindOf } from '../services/holdings/balance-sync-sources';

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
 * Deletes a holding, or hides it (A5 #9).
 *
 * A feed holding is hidden by its owner rather than deleted: its feed would
 * bring it back as an empty row, and the evidence behind its history would be
 * gone. The hide is the owner's, so no feed shows it again; the balance it was
 * hidden at is kept, and a hidden holding that later holds more is named on the
 * data-quality page. A person's snapshot is theirs, and deleting it removes it
 * with its ledger.
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

        if (holdingKindOf(holding) === 'feed') {
          await tx
            .update(schema.holdings)
            .set({ isHidden: true, hiddenBy: 'user', hiddenBalance: holding.balance })
            .where(eq(schema.holdings.id, holdingId));

          logger.info(
            {
              holdingId: holding.id,
              accountId: holding.accountId,
              tokenId: holding.tokenId,
              source: holding.source,
            },
            'Feed holding hidden by its owner'
          );

          return {
            success: true,
            deleted: holding,
            wasHidden: true,
          };
        }

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
          'Snapshot holding deleted'
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
