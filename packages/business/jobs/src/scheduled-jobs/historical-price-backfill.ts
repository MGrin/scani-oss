import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// Nightly chain (3 AM): historical price backfill → forex backfill (3:30 AM)
// → portfolio value rollup (4 AM). Stagger so each step's writes are
// visible to the next.
export const HISTORICAL_PRICE_BACKFILL_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.historicalPriceBackfill,
  cron: '0 3 * * *',
  lockName: JOB_NAMES.historicalPriceBackfill,
};
