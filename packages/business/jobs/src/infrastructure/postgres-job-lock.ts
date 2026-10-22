import { withAdvisoryLock } from '@scani/db';
import { createComponentLogger } from '@scani/logging';
import { JOB_LOCK, JobLock, type JobLockAcquired, type JobLockSkipped } from '@scani/queue';
import { Service } from 'typedi';

const log = createComponentLogger('jobs:postgres-lock');

// Distributed mutual exclusion for scheduled jobs via PostgreSQL
// session-level advisory locks. Two redeploys briefly running in
// parallel must not both fire `pricing` against the same upstream API
// budget.
//
// The lock lives on `withAdvisoryLock`'s one-connection client (SC-1763).
// It used to sit on a reserved POOL connection: on 2026-10-21 Neon dropped
// that connection mid-run, the unlock wrote to the dead socket, and the
// pricing step hung to its 30-minute limit. A lost lock now rejects with
// `AdvisoryLockLostError`, and release ends the client.
//
// Returns `{ ran: false }` when the lock is already held — the caller
// treats that as "skip this tick", since cron jobs are idempotent and
// the next tick runs anyway.
@Service({ id: JOB_LOCK })
export class PostgresJobLock extends JobLock {
  override async withLock<T>(
    lockName: string,
    fn: () => Promise<T>
  ): Promise<JobLockAcquired<T> | JobLockSkipped> {
    const outcome = await withAdvisoryLock(lockName, () => fn());
    if (!outcome.ran) {
      log.warn(
        { jobName: lockName },
        '🔒 Cron job skipped — another instance holds the advisory lock'
      );
    }
    return outcome;
  }
}
