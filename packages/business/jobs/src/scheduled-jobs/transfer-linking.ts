import type { ScheduledJobStepDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// A step of the `nightly` group, after exchange-transactions and before the
// portfolio-value rollup (SC-1688). The rollup's cost-basis walk reads `transfer_group_id`, so
// linking MUST complete before the rollup — otherwise the rollup sees
// day-stale linkage and transfers reset cost basis for a full day.
export const TRANSFER_LINKING_SCHEDULE: ScheduledJobStepDescriptor = {
  name: JOB_NAMES.transferLinking,
  lockName: JOB_NAMES.transferLinking,
};
