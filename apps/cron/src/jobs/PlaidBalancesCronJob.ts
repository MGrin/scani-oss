/**
 * PlaidBalancesCronJob
 *
 * Cron job that runs every 15 minutes to sync Plaid account balances.
 * Updates balances for accounts imported using Plaid integration.
 *
 * Responsibilities:
 * - Fetch current balances from Plaid for all connected accounts
 * - Update existing holdings with new balances
 * - Create new holdings when account owns new tokens
 * - Track sync status and errors
 *
 * Schedule: Every 15 minutes (same as exchange and wallet balances)
 */

import { SyncPlaidBalancesUseCase } from '@scani/core/use-cases';
import { createComponentLogger } from '@scani/core/utils/logger';
import { Container } from 'typedi';

const logger = createComponentLogger('cron:plaid-balances');

/**
 * Execute the Plaid balances cron job
 */
export async function executePlaidBalancesCronJob(): Promise<void> {
  const startTime = Date.now();
  logger.info('🕐 Starting Plaid balances sync cron job');

  try {
    const syncPlaidBalancesUseCase = Container.get(SyncPlaidBalancesUseCase);
    const result = await syncPlaidBalancesUseCase.execute();

    const durationMs = Date.now() - startTime;

    logger.info(
      {
        items: result.itemsSynced,
        accounts: result.accountsUpdated,
        holdings: result.holdingsUpdated,
        duration: `${durationMs}ms`,
      },
      '✅ Plaid balances sync completed'
    );

    // Log errors if any
    if (result.errors.length > 0) {
      logger.warn(
        {
          errors: result.errors.map((e) => ({
            plaidItemId: e.plaidItemId,
            error: e.error,
          })),
        },
        'Some Plaid items failed to sync during Plaid balances cron job'
      );
    }
  } catch (error) {
    const durationMs = Date.now() - startTime;
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        durationMs,
      },
      '❌ Plaid balances sync cron job failed'
    );
    // Don't throw - let the cron job continue on next schedule
  }
}
