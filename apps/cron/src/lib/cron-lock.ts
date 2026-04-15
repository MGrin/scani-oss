import { client } from '@scani/core/database/connection';
import { createComponentLogger } from '@scani/core/utils/logger';

const logger = createComponentLogger('cron:lock');

/**
 * Distributed mutual exclusion for cron jobs via PostgreSQL advisory locks.
 *
 * Why: Render redeploys can briefly overlap two cron containers. Without a
 * lock, both run `SyncWalletBalances` at the same time — doubling external
 * API calls, racing on writes, and potentially getting us rate-limited by
 * exchanges.
 *
 * How: Each job name is hashed to a 64-bit key. We acquire a session-level
 * advisory lock with `pg_try_advisory_lock(key)` on a reserved connection.
 * The lock is released automatically when the connection is returned to the
 * pool, but we also release it explicitly on success/failure.
 *
 * If the lock is already held, the job is skipped (not queued) — cron jobs
 * are idempotent by design and the next tick will run anyway.
 */

/**
 * Deterministic 64-bit signed integer hash of a job name.
 * FNV-1a 64-bit, then cast into the bigint range accepted by pg_advisory_lock.
 */
function hashJobName(name: string): bigint {
  // FNV-1a 64-bit
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK_64 = (1n << 64n) - 1n;

  let hash = FNV_OFFSET;
  for (let i = 0; i < name.length; i++) {
    hash ^= BigInt(name.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK_64;
  }

  // Convert unsigned 64-bit to signed 64-bit (postgres bigint range).
  const SIGNED_MAX = (1n << 63n) - 1n;
  return hash > SIGNED_MAX ? hash - (1n << 64n) : hash;
}

/**
 * Try to execute `fn` while holding a PG advisory lock on `jobName`.
 *
 * Returns:
 *   - `{ ran: true, result }` if the lock was acquired and the job ran
 *   - `{ ran: false }` if another instance already holds the lock (job skipped)
 *
 * Errors thrown by `fn` propagate after the lock is released.
 */
export async function withJobLock<T>(
  jobName: string,
  fn: () => Promise<T>
): Promise<{ ran: true; result: T } | { ran: false }> {
  const key = hashJobName(jobName);

  // Reserve a dedicated connection so the session-level lock is held on the
  // exact connection we run the work on.
  const reserved = await client.reserve();

  // Keys are machine-generated from job names, not user input, so it's safe
  // to interpolate the literal here. postgres.js's tagged-template generic
  // inference doesn't accept bigint params cleanly across all versions, so
  // we cast via `.unsafe()` with a parameter binding instead.
  const keyStr = key.toString();

  try {
    const rows = (await reserved.unsafe('SELECT pg_try_advisory_lock($1::bigint) AS locked', [
      keyStr,
    ])) as Array<{ locked: boolean }>;
    const locked = rows[0]?.locked === true;

    if (!locked) {
      logger.warn(
        { jobName, key: keyStr },
        '🔒 Cron job skipped — another instance holds the advisory lock'
      );
      return { ran: false };
    }

    logger.info({ jobName, key: keyStr }, '🔓 Acquired cron advisory lock');

    try {
      const result = await fn();
      return { ran: true, result };
    } finally {
      try {
        await reserved.unsafe('SELECT pg_advisory_unlock($1::bigint)', [keyStr]);
        logger.info({ jobName }, '🔓 Released cron advisory lock');
      } catch (unlockErr) {
        logger.error(
          { jobName, error: unlockErr },
          'Failed to release advisory lock (will auto-release when session ends)'
        );
      }
    }
  } finally {
    // Always return the reserved connection to the pool. This also releases
    // any advisory lock we may still hold on it as a belt-and-braces cleanup.
    reserved.release();
  }
}
