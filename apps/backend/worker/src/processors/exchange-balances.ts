import { SyncExchangeBalancesUseCase } from '@scani/domain/use-cases';
import { EXCHANGE_BALANCES_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { ScheduledJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';
import { afterLedgerRows } from '../lib/after-ledger-rows';

const logger = createComponentLogger('processor:exchange-balances');

@Service()
export class ExchangeBalancesProcessor extends ScheduledJobProcessor {
  readonly descriptor = EXCHANGE_BALANCES_SCHEDULE;

  protected async handle(): Promise<void> {
    const startTime = Date.now();
    logger.info('🕐 Starting exchange balances sync');
    try {
      const useCase = Container.get(SyncExchangeBalancesUseCase);
      const result = await useCase.execute();
      logger.info(
        {
          synced: result.accountsSynced,
          failed: result.accountsFailed,
          holdings: `+${result.holdingsCreated} ~${result.holdingsUpdated} -${result.holdingsRemoved}`,
          durationMs: Date.now() - startTime,
        },
        '✅ Exchange balances sync completed'
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
              institutionId: e.institutionId,
              error: e.error,
            })),
          },
          'Some exchange accounts failed to sync'
        );
      }
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startTime,
        },
        '❌ Exchange balances sync failed'
      );
      throw error;
    }
  }
}
