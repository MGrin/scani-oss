import { isConnectionPoolerUrl } from '@scani/config';
import { advisoryLockKey } from './advisory-lock-key';
import { client } from './connection';

/**
 * Distributed mutual exclusion via PostgreSQL session-level advisory locks.
 *
 * Used to serialize logical units of work that span multiple processes /
 * containers — e.g. cron jobs (so a redeploy-overlapping pair of workers
 * doesn't double-run a nightly task), or per-user pipelines (so a
 * user-initiated backfill and the cron sweep don't race on the same
 * user's rows).
 *
 * Behaviour: if the lock is already held, `fn` is NOT executed and the
 * caller receives `{ ran: false }`. The expectation is that either the
 * other holder is doing the work (caller can no-op safely) or the caller
 * will retry on the next tick. Lock is auto-released when the reserved
 * connection is returned to the pool, with explicit unlock on the happy
 * path as belt-and-braces.
 */

export async function withAdvisoryLock<T>(
  key: string,
  fn: () => Promise<T>
): Promise<{ ran: true; result: T } | { ran: false }> {
  const lockKey = advisoryLockKey(key).toString();
  const reserved = await reserveForSessionLock();

  try {
    const rows = (await reserved.unsafe('SELECT pg_try_advisory_lock($1::bigint) AS locked', [
      lockKey,
    ])) as Array<{ locked: boolean }>;
    const locked = rows[0]?.locked === true;
    if (!locked) return { ran: false };

    try {
      const result = await fn();
      return { ran: true, result };
    } finally {
      try {
        await reserved.unsafe('SELECT pg_advisory_unlock($1::bigint)', [lockKey]);
      } catch {
        // Auto-release on connection close still applies.
      }
    }
  } finally {
    reserved.release();
  }
}

/**
 * A reserved connection a session advisory lock can live on, refused through a
 * connection pooler (SC-1442). A skipped lock is silent by design, so a lock
 * the pooler can never release would read as a quiet user whose history
 * stopped moving; failing here is what makes it visible.
 */
export async function reserveForSessionLock() {
  if (isConnectionPoolerUrl(process.env.DATABASE_URL ?? '')) {
    throw new Error(
      'Session advisory lock refused: DATABASE_URL goes through a connection pooler, which cannot release it. Use the direct host (SC-1442).'
    );
  }
  return client.reserve();
}
