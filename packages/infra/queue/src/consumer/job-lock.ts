import { Token } from 'typedi';

// Per-job-name distributed lock for scheduled processors. Two redeploys
// briefly running in parallel must not both fire `pricing` against the
// same upstream API budget. Concrete impl typically uses
// pg_try_advisory_lock; lives in @scani/jobs (depends on @scani/db).
//
// `tryAcquire` returns `{ ran: false }` when the lock is already held —
// the caller treats that as "skip this tick", since cron jobs are
// idempotent by design and the next tick runs anyway.
export interface JobLockAcquired<T> {
  ran: true;
  result: T;
}
export interface JobLockSkipped {
  ran: false;
}

export abstract class JobLock {
  abstract withLock<T>(
    lockName: string,
    fn: () => Promise<T>
  ): Promise<JobLockAcquired<T> | JobLockSkipped>;
}

export const JOB_LOCK = new Token<JobLock>('queue.job-lock');
