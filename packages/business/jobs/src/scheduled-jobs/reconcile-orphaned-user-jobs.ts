import type { ScheduledJobStepDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// No lock — idempotent re-scan. Backend inserts the user_jobs mirror
// row before queue.add(); if it crashes between them, the row sits in
// 'queued' forever. This sweeper marks abandoned rows 'failed'.
// Jitter smooths the load across replicas. A step of the `housekeeping`
// group, every 15 minutes (SC-1688).
export const RECONCILE_ORPHANED_USER_JOBS_SCHEDULE: ScheduledJobStepDescriptor = {
  name: JOB_NAMES.reconcileOrphanedUserJobs,
  jitterMs: 10_000,
};
