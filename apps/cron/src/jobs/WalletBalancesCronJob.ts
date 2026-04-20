/**
 * WalletBalancesCronJob
 *
 * Cron job that runs every 15 minutes to sync wallet balances from blockchain.
 * Updates balances for accounts imported using blockchain services.
 *
 * Responsibilities:
 * - Fetch current balances from blockchain for all wallet accounts
 * - Update existing holdings with new balances
 * - Remove holdings when balance goes to 0
 * - Create new holdings when wallet owns new tokens
 *
 * Schedule: Every 15 minutes
 */

import { SyncWalletBalancesUseCase } from '@scani/domain/use-cases';
import { createComponentLogger } from '@scani/logging';
import { Container } from 'typedi';

const logger = createComponentLogger('cron:wallet-balances');

/**
 * Execute the wallet balances cron job
 */
export async function executeWalletBalancesCronJob(): Promise<void> {
  const startTime = Date.now();
  logger.info('🕐 Starting wallet balances sync cron job');

  try {
    const syncWalletBalancesUseCase = Container.get(SyncWalletBalancesUseCase);
    const result = await syncWalletBalancesUseCase.execute();

    const durationMs = Date.now() - startTime;

    logger.info(
      {
        synced: result.accountsSynced,
        failed: result.accountsFailed,
        holdings: `+${result.holdingsCreated} ~${result.holdingsUpdated} -${result.holdingsRemoved}`,
        duration: `${durationMs}ms`,
      },
      '✅ Wallet balances sync completed'
    );

    // Log errors if any
    if (result.errors.length > 0) {
      logger.warn(
        {
          errors: result.errors.map((e) => ({
            accountName: e.accountName,
            walletAddress: `${e.walletAddress.substring(0, 10)}...`,
            error: e.error,
          })),
        },
        'Some wallet accounts failed to sync during wallet balances cron job'
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
      '❌ Wallet balances sync cron job failed'
    );
    throw error;
  }
}
