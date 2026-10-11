import type { ScheduledJobStepDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// No lock — idempotent re-scan. The backend marks rows pending_enqueue,
// calls BullMQ.add(), and promotes to 'enqueued'. If the backend dies
// in between, this sweeper re-enqueues. Two parallel sweepers ask for the
// same import, because its requestId is derived from the credential, so the
// import's jobId collapses the duplicate (SC-1688). Jitter smooths the load when multiple worker replicas
// run side by side — without it both replicas hit the orphan query at
// the exact same wallclock second.
//
// Every 15 minutes, as a step of the `housekeeping` group (SC-1688); an
// every-minute cadence kept the DB awake 24/7 (~$19/mo of compute floor). The failure this sweeps is rare (backend dying between the DB
// write and queue.add), so up-to-15-min recovery latency is acceptable.
export const RECONCILE_PENDING_CREDENTIALS_SCHEDULE: ScheduledJobStepDescriptor = {
  name: JOB_NAMES.reconcilePendingCredentials,
  jitterMs: 10_000,
};
