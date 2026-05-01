import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// No lock — idempotent re-scan. Backend inserts the user_jobs mirror
// row before queue.add(); if it crashes between them, the row sits in
// 'queued' forever. This sweeper marks abandoned rows 'failed'.
export const RECONCILE_ORPHANED_USER_JOBS_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.reconcileOrphanedUserJobs,
  cron: '* * * * *',
};
