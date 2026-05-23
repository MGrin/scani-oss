import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// Runs at 03:45, inside the nightly chain (03:00 historical-price
// backfill → 03:30 forex → 03:45 transfer-linking → 04:00 rollup). The
// portfolio-value rollup's cost-basis walk reads `transfer_group_id`, so
// linking MUST complete before the rollup — otherwise the rollup sees
// day-stale linkage and transfers reset cost basis for a full day.
export const TRANSFER_LINKING_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.transferLinking,
  cron: '45 3 * * *',
  lockName: JOB_NAMES.transferLinking,
};
