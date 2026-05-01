import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// No lock — idempotent re-scan. The backend marks rows pending_enqueue,
// calls BullMQ.add(), and promotes to 'enqueued'. If the backend dies
// in between, this sweeper re-enqueues. Two parallel sweepers would
// briefly double-enqueue but BullMQ's deterministic-jobId dedup catches
// the duplicate.
export const RECONCILE_PENDING_CREDENTIALS_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.reconcilePendingCredentials,
  cron: '* * * * *',
};
