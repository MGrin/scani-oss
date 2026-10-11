import type { ScheduledJobStepDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

export const APY_PAYOUTS_SCHEDULE: ScheduledJobStepDescriptor = {
  name: JOB_NAMES.apyPayouts,
  lockName: JOB_NAMES.apyPayouts,
};
