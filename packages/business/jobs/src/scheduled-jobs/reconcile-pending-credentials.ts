import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// No lock — idempotent re-scan. The backend marks rows pending_enqueue,
// calls BullMQ.add(), and promotes to 'enqueued'. If the backend dies
// in between, this sweeper re-enqueues. Two parallel sweepers would
// briefly double-enqueue but BullMQ's deterministic-jobId dedup catches
// the duplicate. Jitter smooths the load when multiple worker replicas
// run side by side — without it both replicas hit the orphan query at
// the exact same wallclock second.
//
// Every 15 minutes, quarter-hour aligned with the other frequent jobs,
// so Neon's scale-to-zero gets long idle windows between batched wakes
// (an every-minute cadence kept the DB awake 24/7 — ~$19/mo of compute
// floor). The failure this sweeps is rare (backend dying between the DB
// write and queue.add), so up-to-15-min recovery latency is acceptable.
export const RECONCILE_PENDING_CREDENTIALS_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.reconcilePendingCredentials,
  cron: '*/15 * * * *',
  jitterMs: 10_000,
};
