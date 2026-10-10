import { SyncWalletBalancesUseCase } from '@scani/domain/use-cases';
import { WALLET_BALANCES_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { ScheduledJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';
import { afterLedgerRows } from '../lib/after-ledger-rows';

const logger = createComponentLogger('processor:wallet-balances');

@Service()
export class WalletBalancesProcessor extends ScheduledJobProcessor {
  readonly descriptor = WALLET_BALANCES_SCHEDULE;

  protected async handle(): Promise<void> {
    const startTime = Date.now();
    logger.info('🕐 Starting wallet balances sync');
    try {
      const useCase = Container.get(SyncWalletBalancesUseCase);
      const result = await useCase.execute();
      logger.info(
        {
          synced: result.accountsSynced,
          failed: result.accountsFailed,
          holdings: `+${result.holdingsCreated} ~${result.holdingsUpdated} -${result.holdingsRemoved}`,
          // The only thing this run wrote that no human authorised. Logged as
          // the symbol list rather than a count so an operator reading a
          // suspiciously long one during an upstream incident can say WHICH
          // holdings were anchored at zero, and on which accounts (SC-872).
          exitedSymbols: result.exitedSymbols,
          durationMs: Date.now() - startTime,
        },
        '✅ Wallet balances sync completed'
      );
      // Each ledger read with its balance that wrote rows (SC-1665).
      for (const write of result.ledgerWrites) {
        await afterLedgerRows(
          { userId: write.userId, accountId: write.accountId, source: write.result.source },
          write.result
        );
      }
      if (result.errors.length > 0) {
        logger.warn(
          {
            errors: result.errors.map((e) => ({
              accountName: e.accountName,
              walletAddress: `${e.walletAddress.substring(0, 10)}...`,
              error: e.error,
            })),
          },
          'Some wallet accounts failed to sync'
        );
      }
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startTime,
        },
        '❌ Wallet balances sync failed'
      );
      throw error;
    }
  }
}
