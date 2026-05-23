import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

export const APY_PAYOUTS_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.apyPayouts,
  cron: '0 0 * * *',
  lockName: JOB_NAMES.apyPayouts,
};
