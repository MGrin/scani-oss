import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// No lock — idempotent re-scan. Backend inserts the user_jobs mirror
// row before queue.add(); if it crashes between them, the row sits in
// 'queued' forever. This sweeper marks abandoned rows 'failed'.
// Jitter smooths the load across replicas; the quarter-hour cadence
// batches DB wakes so Neon can scale to zero in between (see sibling
// reconcile-pending-credentials descriptor for the full rationale).
export const RECONCILE_ORPHANED_USER_JOBS_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.reconcileOrphanedUserJobs,
  cron: '*/15 * * * *',
  jitterMs: 10_000,
};
