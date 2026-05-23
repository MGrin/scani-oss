import { client } from '@scani/db/connection';
import { createComponentLogger } from '@scani/logging';
import { JOB_LOCK, JobLock, type JobLockAcquired, type JobLockSkipped } from '@scani/queue';
import { Service } from 'typedi';

const log = createComponentLogger('jobs:postgres-lock');

// Distributed mutual exclusion for scheduled jobs via PostgreSQL
// session-level advisory locks. Two redeploys briefly running in
// parallel must not both fire `pricing` against the same upstream API
// budget.
//
// Keys: deterministic 64-bit FNV-1a hash of the job name, then cast
// into bigint range. The lock is held on a reserved connection and
// auto-released when the connection returns to the pool (and explicitly
// via pg_advisory_unlock as belt-and-braces).
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
    const key = hashJobName(lockName);
    const reserved = await client.reserve();
    const keyStr = key.toString();

    try {
      const rows = (await reserved.unsafe('SELECT pg_try_advisory_lock($1::bigint) AS locked', [
        keyStr,
      ])) as Array<{ locked: boolean }>;
      const locked = rows[0]?.locked === true;

      if (!locked) {
        log.warn(
          { jobName: lockName, key: keyStr },
          '🔒 Cron job skipped — another instance holds the advisory lock'
        );
        return { ran: false };
      }

      log.info({ jobName: lockName, key: keyStr }, '🔓 Acquired cron advisory lock');

      try {
        const result = await fn();
        return { ran: true, result };
      } finally {
        try {
          await reserved.unsafe('SELECT pg_advisory_unlock($1::bigint)', [keyStr]);
          log.info({ jobName: lockName }, '🔓 Released cron advisory lock');
        } catch (unlockErr) {
          log.error(
            { jobName: lockName, error: unlockErr },
            'Failed to release advisory lock (will auto-release when session ends)'
          );
        }
      }
    } finally {
      reserved.release();
    }
  }
}

// FNV-1a 64-bit, then cast into the signed bigint range pg_advisory_lock
// accepts. Deterministic — same job name always hashes to the same key
// across processes / redeploys.
function hashJobName(name: string): bigint {
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK_64 = (1n << 64n) - 1n;

  let hash = FNV_OFFSET;
  for (let i = 0; i < name.length; i++) {
    hash ^= BigInt(name.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK_64;
  }

  const SIGNED_MAX = (1n << 63n) - 1n;
  return hash > SIGNED_MAX ? hash - (1n << 64n) : hash;
}
