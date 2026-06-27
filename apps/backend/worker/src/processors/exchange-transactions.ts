import { randomUUID } from 'node:crypto';
import { SyncExchangeTransactionsUseCase } from '@scani/domain/use-cases';
import { EXCHANGE_TRANSACTIONS_SCHEDULE, TRANSACTION_IMPORT } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { BullMqEnqueueService, ScheduledJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('processor:exchange-transactions');

@Service()
export class ExchangeTransactionsProcessor extends ScheduledJobProcessor {
  readonly descriptor = EXCHANGE_TRANSACTIONS_SCHEDULE;

  protected async handle(): Promise<void> {
    const startTime = Date.now();
    logger.info('🕐 Starting recurring transaction sync');
    try {
      const result = await Container.get(SyncExchangeTransactionsUseCase).execute();
      const enqueue = Container.get(BullMqEnqueueService);

      let enqueued = 0;
      for (const target of result.targets) {
        await enqueue.add(TRANSACTION_IMPORT, {
          userId: target.userId,
          requestId: randomUUID(),
          accountId: target.accountId,
          source: target.source,
          since: target.since,
          institutionId: target.institutionId,
        });
        enqueued++;
      }

      logger.info(
        {
          accountsFound: result.accountsFound,
          enqueued,
          skippedNoSource: result.skippedNoSource,
          durationMs: Date.now() - startTime,
        },
        '✅ Recurring transaction sync enqueued'
      );
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startTime,
        },
        '❌ Recurring transaction sync failed'
      );
      throw error;
    }
  }
}
