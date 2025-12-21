/**
 * SyncPlaidBalancesUseCase
 *
 * Syncs account balances from Plaid for all active Plaid items
 * Used for periodic background sync (cron job)
 */

import { createPlaidIntegration } from '@scani/integrations';
import { isValidDecimalString } from '@scani/shared';
import { and, eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { db } from '../database/connection';
import * as schema from '../database/schema';
import { HoldingRepository } from '../repositories/HoldingRepository';
import { TokenService } from '../services/TokenService';
import { createComponentLogger } from '../utils/logger';

const logger = createComponentLogger('use-case:sync-plaid-balances');

export interface SyncPlaidBalancesInput {
  /** User ID (optional, if not provided syncs all users) */
  userId?: string;
  /** Plaid item ID (optional, if not provided syncs all items) */
  plaidItemId?: string;
}

export interface SyncPlaidBalancesResult {
  /** Total items synced */
  itemsSynced: number;
  /** Total accounts updated */
  accountsUpdated: number;
  /** Total holdings updated */
  holdingsUpdated: number;
  /** Errors encountered during sync */
  errors: Array<{
    plaidItemId: string;
    error: string;
  }>;
}

/**
 * Sync Plaid Balances Use Case
 */
@Service()
export class SyncPlaidBalancesUseCase {
  private readonly tokenService = Container.get(TokenService);
  private readonly holdingRepository = Container.get(HoldingRepository);

  async execute(input: SyncPlaidBalancesInput = {}): Promise<SyncPlaidBalancesResult> {
    logger.info(input, 'Starting Plaid balances sync');

    const result: SyncPlaidBalancesResult = {
      itemsSynced: 0,
      accountsUpdated: 0,
      holdingsUpdated: 0,
      errors: [],
    };

    try {
      // Get all active Plaid items (optionally filtered by user/item)
      const conditions = [eq(schema.plaidItems.isActive, true)];

      if (input.userId) {
        conditions.push(eq(schema.plaidItems.userId, input.userId));
      }

      if (input.plaidItemId) {
        conditions.push(eq(schema.plaidItems.plaidItemId, input.plaidItemId));
      }

      const plaidItems = await db
        .select()
        .from(schema.plaidItems)
        .where(and(...conditions));

      logger.info({ itemCount: plaidItems.length }, 'Found Plaid items to sync');

      // Sync each item
      for (const plaidItem of plaidItems) {
        try {
          await this.syncPlaidItem(plaidItem, result);
          result.itemsSynced++;
        } catch (error) {
          logger.error({ plaidItemId: plaidItem.plaidItemId, error }, 'Failed to sync Plaid item');
          result.errors.push({
            plaidItemId: plaidItem.plaidItemId,
            error: error instanceof Error ? error.message : 'Unknown error',
          });

          // Update item with error
          await db
            .update(schema.plaidItems)
            .set({
              error: {
                message: error instanceof Error ? error.message : 'Unknown error',
                timestamp: new Date().toISOString(),
              },
            })
            .where(eq(schema.plaidItems.id, plaidItem.id));
        }
      }

      logger.info(
        {
          itemsSynced: result.itemsSynced,
          accountsUpdated: result.accountsUpdated,
          holdingsUpdated: result.holdingsUpdated,
          errorCount: result.errors.length,
        },
        'Plaid balances sync completed'
      );

      return result;
    } catch (error) {
      logger.error({ error }, 'Failed to sync Plaid balances');
      throw error;
    }
  }

  /**
   * Sync a single Plaid item
   */
  private async syncPlaidItem(
    plaidItem: schema.PlaidItem,
    result: SyncPlaidBalancesResult
  ): Promise<void> {
    logger.info({ plaidItemId: plaidItem.plaidItemId }, 'Syncing Plaid item');

    // Create integration instance
    const integration = createPlaidIntegration(plaidItem.institutionId);

    // Get all account mappings for this item
    const accountMappings = await db
      .select()
      .from(schema.plaidAccountMappings)
      .where(eq(schema.plaidAccountMappings.plaidItemId, plaidItem.id));

    // Sync each account
    for (const mapping of accountMappings) {
      try {
        // Fetch balances for this account
        const holdingsResult = await integration.fetchHoldings(mapping.plaidAccountId, {
          accessToken: plaidItem.plaidAccessToken,
        });

        if (holdingsResult.errors && holdingsResult.errors.length > 0) {
          logger.warn(
            { plaidAccountId: mapping.plaidAccountId, errors: holdingsResult.errors },
            'Errors fetching holdings'
          );
        }

        // Update holdings
        for (const holding of holdingsResult.holdings) {
          try {
            if (!isValidDecimalString(holding.balance)) {
              logger.warn({ holding }, 'Invalid balance value, skipping');
              continue;
            }

            // Map token
            const tokenMapping = await integration.mapToken(holding);

            // Determine token type from holding
            // For bank accounts (depository/credit/loan), tokenType will be 'fiat'
            // For investment accounts, tokenType may be undefined - default to 'fiat'
            // This allows investment accounts to potentially hold stocks, ETFs, or other securities
            const tokenTypeCode = holding.tokenType || 'fiat';

            // Get token type from database
            const [tokenType] = await db
              .select()
              .from(schema.tokenTypes)
              .where(eq(schema.tokenTypes.code, tokenTypeCode))
              .limit(1);

            if (!tokenType) {
              throw new Error(`Token type '${tokenTypeCode}' not found`);
            }

            // Create or get token using integration mapping
            const token = await this.tokenService.findOrCreateTokenFromIntegration(
              tokenMapping,
              tokenType.id,
              holding.decimals || 2 // Use decimals from holding, default to 2 for fiat
            );

            // Check if holding already exists
            const existingHolding = await this.holdingRepository.findByAccountAndToken(
              mapping.scaniAccountId,
              token.id,
              plaidItem.userId
            );

            if (existingHolding) {
              // Update existing holding
              await this.holdingRepository.update(existingHolding.id, {
                balance: holding.balance,
              });
            } else {
              // Create new holding
              await this.holdingRepository.create({
                userId: plaidItem.userId,
                accountId: mapping.scaniAccountId,
                tokenId: token.id,
                balance: holding.balance,
                isHidden: false,
              });
            }

            result.holdingsUpdated++;
          } catch (error) {
            logger.error(
              { accountId: mapping.scaniAccountId, holding, error },
              'Failed to update holding'
            );
          }
        }

        // Update account metadata with lastSync timestamp
        const [account] = await db
          .select()
          .from(schema.accounts)
          .where(eq(schema.accounts.id, mapping.scaniAccountId))
          .limit(1);

        if (account) {
          const updatedMetadata = {
            ...(account.metadata && typeof account.metadata === 'object' ? account.metadata : {}),
            lastSync: new Date().toISOString(),
          };

          await db
            .update(schema.accounts)
            .set({
              metadata: updatedMetadata,
              updatedAt: new Date(),
            })
            .where(eq(schema.accounts.id, mapping.scaniAccountId));

          logger.debug({ accountId: mapping.scaniAccountId }, 'Updated account lastSync timestamp');
        }

        result.accountsUpdated++;
      } catch (error) {
        logger.error({ plaidAccountId: mapping.plaidAccountId, error }, 'Failed to sync account');
      }
    }

    // Update last sync time
    await db
      .update(schema.plaidItems)
      .set({
        lastSuccessfulSync: new Date(),
        lastBalanceSync: new Date(),
        error: null, // Clear any previous errors
      })
      .where(eq(schema.plaidItems.id, plaidItem.id));
  }
}
