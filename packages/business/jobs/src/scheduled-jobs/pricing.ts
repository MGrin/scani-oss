import type { ScheduledJobStepDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

export const PRICING_SCHEDULE: ScheduledJobStepDescriptor = {
  name: JOB_NAMES.pricing,
  lockName: JOB_NAMES.pricing,
};
