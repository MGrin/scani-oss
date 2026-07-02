import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// Runs after the nightly pricing chain (rollup 04:00, forex 03:30) so the
// day's intraday data is complete before older days are collapsed to daily.
export const TOKEN_PRICES_DOWNSAMPLE_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.tokenPricesDownsample,
  cron: '0 5 * * *',
  lockName: JOB_NAMES.tokenPricesDownsample,
};

// Full-resolution intraday prices are kept for this many whole UTC days;
// anything older is collapsed to one daily row per token/base/day.
export const TOKEN_PRICES_INTRADAY_RETENTION_DAYS = 7;
