import type { ScheduledJobStepDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// AI category suggestions for the people who turned them on (SC-1695). A step
// of the `hourly` group rather than a job per import: `@scani/domain`, where
// imports finish, cannot enqueue, and with five calls a day a faster trigger
// buys nothing. Each run asks only about payees nobody has asked about yet.
export const CATEGORIZE_TRANSACTIONS_SCHEDULE: ScheduledJobStepDescriptor = {
  name: JOB_NAMES.categorizeTransactions,
  lockName: JOB_NAMES.categorizeTransactions,
};
