import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

export const PRICING_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.pricing,
  cron: '0 * * * *',
  lockName: JOB_NAMES.pricing,
};
