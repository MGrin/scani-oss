import { SyncWalletBalancesUseCase } from '@scani/domain/use-cases';
import { WALLET_BALANCES_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { ScheduledJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';

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
          durationMs: Date.now() - startTime,
        },
        '✅ Wallet balances sync completed'
      );
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
