import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// No lock — idempotent re-scan. The backend marks rows pending_enqueue,
// calls BullMQ.add(), and promotes to 'enqueued'. If the backend dies
// in between, this sweeper re-enqueues. Two parallel sweepers would
// briefly double-enqueue but BullMQ's deterministic-jobId dedup catches
// the duplicate. Jitter smooths the every-minute load when multiple
// worker replicas run side by side — without it both replicas hit the
// orphan query at the exact same wallclock second.
export const RECONCILE_PENDING_CREDENTIALS_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.reconcilePendingCredentials,
  cron: '* * * * *',
  jitterMs: 10_000,
};
