import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// No lock — idempotent re-scan. Backend inserts the user_jobs mirror
// row before queue.add(); if it crashes between them, the row sits in
// 'queued' forever. This sweeper marks abandoned rows 'failed'.
// Jitter smooths the every-minute load across replicas (see sibling
// reconcile-pending-credentials descriptor for the rationale).
export const RECONCILE_ORPHANED_USER_JOBS_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.reconcileOrphanedUserJobs,
  cron: '* * * * *',
  jitterMs: 10_000,
};
