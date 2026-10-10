import type { ScheduledJobStepDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// A step of the `nightly` group, ahead of transfer linking and the portfolio
// value rollup, which values holdings with these prices (SC-1688).
export const HISTORICAL_PRICE_BACKFILL_SCHEDULE: ScheduledJobStepDescriptor = {
  name: JOB_NAMES.historicalPriceBackfill,
  lockName: JOB_NAMES.historicalPriceBackfill,
};
