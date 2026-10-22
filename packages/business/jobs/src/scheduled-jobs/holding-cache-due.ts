import type { ScheduledJobStepDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// Rewrites a holding's cached balance once evidence dated after its last write
// has happened (SC-1633). Locked: two sweeps would refresh the same holdings.
export const HOLDING_CACHE_DUE_SCHEDULE: ScheduledJobStepDescriptor = {
  name: JOB_NAMES.holdingCacheDue,
  lockName: JOB_NAMES.holdingCacheDue,
};
