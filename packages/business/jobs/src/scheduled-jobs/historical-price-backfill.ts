import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// Nightly chain: historical price backfill (03:00) → transfer linking (03:45)
// → portfolio value rollup (04:00). Stagger so each step's writes are
// visible to the next.
export const HISTORICAL_PRICE_BACKFILL_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.historicalPriceBackfill,
  cron: '0 3 * * *',
  lockName: JOB_NAMES.historicalPriceBackfill,
};
