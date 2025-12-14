/**
 * ExchangeBalancesCronJob
 *
 * Cron job that runs every 15 minutes to sync exchange balances.
 * Updates balances for accounts imported using exchange integrations (Binance, etc.).
 *
 * Responsibilities:
 * - Fetch current balances from exchanges for all exchange accounts
 * - Update existing holdings with new balances
 * - Remove holdings when balance goes to 0
 * - Create new holdings when account owns new tokens
 *
 * Schedule: Every 15 minutes
 */

import { SyncExchangeBalancesUseCase } from '@scani/core/use-cases';
import { createComponentLogger } from '@scani/core/utils/logger';
import { Container } from 'typedi';

const logger = createComponentLogger('cron:exchange-balances');

/**
 * Execute the exchange balances cron job
 */
export async function executeExchangeBalancesCronJob(): Promise<void> {
  const startTime = Date.now();
  logger.info('🕐 Starting exchange balances sync cron job');

  try {
    const syncExchangeBalancesUseCase = Container.get(SyncExchangeBalancesUseCase);
    const result = await syncExchangeBalancesUseCase.execute();

    const durationMs = Date.now() - startTime;

    logger.info(
      {
        accountsFound: result.accountsFound,
        accountsSynced: result.accountsSynced,
        accountsFailed: result.accountsFailed,
        holdingsUpdated: result.holdingsUpdated,
        holdingsCreated: result.holdingsCreated,
        holdingsRemoved: result.holdingsRemoved,
        errorCount: result.errors.length,
        useCaseDurationMs: result.durationMs,
        totalDurationMs: durationMs,
      },
      '✅ Exchange balances sync cron job completed successfully'
    );

    // Log errors if any
    if (result.errors.length > 0) {
      logger.warn(
        {
          errors: result.errors.map((e) => ({
            accountName: e.accountName,
            institutionId: e.institutionId,
            error: e.error,
          })),
        },
        'Some exchange accounts failed to sync during exchange balances cron job'
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
      '❌ Exchange balances sync cron job failed'
    );
    // Don't throw - let the cron job continue on next schedule
  }
}
