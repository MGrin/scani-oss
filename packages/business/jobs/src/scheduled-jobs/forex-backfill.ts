import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

export const FOREX_BACKFILL_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.forexBackfill,
  cron: '30 3 * * *',
  lockName: JOB_NAMES.forexBackfill,
};
