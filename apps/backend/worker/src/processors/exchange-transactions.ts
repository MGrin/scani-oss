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

  // Only the occurrence's id is read, so no bullmq type is needed here.
  protected async handle(job: { readonly id?: string }): Promise<void> {
    const startTime = Date.now();
    logger.info('🕐 Starting recurring transaction sync');
    try {
      const result = await Container.get(SyncExchangeTransactionsUseCase).execute();
      const enqueue = Container.get(BullMqEnqueueService);

      // The requestId is part of each child's jobId. Deriving it from this
      // occurrence makes a second attempt of the same run collapse onto the
      // imports it already queued, and a failed enqueue is counted rather than
      // thrown so no retry re-sends the targets that did go out (SC-1688).
      const runKey = job.id ?? randomUUID();
      let enqueued = 0;
      let enqueueFailed = 0;
      for (const target of result.targets) {
        try {
          await enqueue.add(TRANSACTION_IMPORT, {
            userId: target.userId,
            requestId: `${runKey}:${target.accountId}`,
            accountId: target.accountId,
            source: target.source,
            since: target.since,
            institutionId: target.institutionId,
          });
          enqueued++;
        } catch (error) {
          enqueueFailed++;
          logger.error(
            {
              accountId: target.accountId,
              userId: target.userId,
              error: error instanceof Error ? error.message : String(error),
            },
            '❌ Transaction import not enqueued; the next nightly run retries it'
          );
        }
      }

      logger.info(
        {
          accountsFound: result.accountsFound,
          enqueued,
          enqueueFailed,
          skippedNoSource: result.skippedNoSource,
          fullHistoryTargets: result.fullHistoryTargets,
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
