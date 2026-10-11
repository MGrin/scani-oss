import { isConnectionPoolerUrl } from '@scani/config';
import { advisoryLockKey } from './advisory-lock-key';
import { client, createSessionLockClient } from './connection';

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
 * will retry on the next tick.
 *
 * The lock lives on a client of its own (SC-1613). If that connection dies,
 * Postgres frees the lock while `fn` is still running: `lock.signal` aborts
 * when the client sees the socket close, and `lock.assertHeld()` asks the
 * server, which also catches a drop the client has not noticed yet. A long
 * `fn` calls it before each write batch. A loss is never returned as a clean
 * run: the call rejects with `AdvisoryLockLostError`. Release is ending the
 * client, which never writes to a dead socket.
 */

export class AdvisoryLockLostError extends Error {
  override name = 'AdvisoryLockLostError';
}

export interface AdvisoryLock {
  readonly signal: AbortSignal;
  assertHeld(): Promise<void>;
}

const HELD_SQL = `select exists (
  select 1 from pg_locks
   where locktype = 'advisory' and granted and objsubid = 1 and pid = $1
     and classid = (($2::bigint >> 32) & 4294967295)::oid
     and objid = ($2::bigint & 4294967295)::oid
) as held`;

export async function withAdvisoryLock<T>(
  key: string,
  fn: (lock: AdvisoryLock) => Promise<T>
): Promise<{ ran: true; result: T } | { ran: false }> {
  refusePooler();
  const lockKey = advisoryLockKey(key).toString();
  const lost = new AbortController();
  const loseLock = () => {
    if (!lost.signal.aborted) {
      lost.abort(
        new AdvisoryLockLostError(`Advisory lock "${key}" lost: its connection closed (SC-1613)`)
      );
    }
  };
  let holding = false;
  const session = createSessionLockClient(() => {
    if (holding) loseLock();
  });

  try {
    const rows = (await session.unsafe(
      'SELECT pg_try_advisory_lock($1::bigint) AS locked, pg_backend_pid() AS pid',
      [lockKey]
    )) as Array<{ locked: boolean; pid: number }>;
    const row = rows[0];
    if (row?.locked !== true) return { ran: false };
    holding = true;

    const lock: AdvisoryLock = {
      signal: lost.signal,
      async assertHeld() {
        lost.signal.throwIfAborted();
        const held = (await client.unsafe(HELD_SQL, [row.pid, lockKey])) as Array<{
          held: boolean;
        }>;
        if (held[0]?.held !== true) loseLock();
        lost.signal.throwIfAborted();
      },
    };

    const result = await fn(lock);
    await lock.assertHeld();
    return { ran: true, result };
  } finally {
    holding = false;
    await session.end({ timeout: lost.signal.aborted ? 0 : 5 }).catch(() => {});
  }
}

function refusePooler(): void {
  if (isConnectionPoolerUrl(process.env.DATABASE_URL ?? '')) {
    throw new Error(
      'Session advisory lock refused: DATABASE_URL goes through a connection pooler, which cannot release it. Use the direct host (SC-1442).'
    );
  }
}

/**
 * A reserved connection a session advisory lock can live on, refused through a
 * connection pooler (SC-1442). A skipped lock is silent by design, so a lock
 * the pooler can never release would read as a quiet user whose history
 * stopped moving; failing here is what makes it visible.
 */
export async function reserveForSessionLock() {
  refusePooler();
  return client.reserve();
}
