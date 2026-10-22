import { db } from '@scani/db/connection';
import { HoldingCacheDueSweep } from '@scani/domain/services/feeds/HoldingCacheDueSweep';
import { HOLDING_CACHE_DUE_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { ScheduledJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('processor:holding-cache-due');

// One fire's bound; the rest are due on the next quarter-hour.
const BATCH_LIMIT = 200;

@Service()
export class HoldingCacheDueProcessor extends ScheduledJobProcessor {
  readonly descriptor = HOLDING_CACHE_DUE_SCHEDULE;

  protected async handle(): Promise<void> {
    const sweep = Container.get(HoldingCacheDueSweep);
    const refreshed = await db.transaction((tx) => sweep.refreshDue(tx, new Date(), BATCH_LIMIT));
    if (refreshed > 0) logger.info({ refreshed }, 'due holding caches rewritten');
  }
}
