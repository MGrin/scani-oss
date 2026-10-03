import { type DatabaseTransaction, getDb } from '@scani/db';
import { sql } from 'drizzle-orm';
import { databaseErrorOf } from '../../src/lib/database-error';

/** The server backend running `tx`, which `pg_blocking_pids` names. */
export async function backendPid(tx: DatabaseTransaction): Promise<number> {
  const [row] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
  if (row === undefined) throw new Error('pg_backend_pid() returned no row');
  return row.pid;
}

/**
 * Polls until the waiter's backend is blocked by the holder's, and says whether
 * it was. Asked of that one pair, so another session's lock wait on a shared
 * database cannot read as this one. False once the waiter settles without
 * having been blocked, or at the deadline.
 */
export async function waitUntilBlocked(
  waiter: { pid: () => number | undefined; settled: Promise<unknown> },
  holderPid: number,
  timeoutMs = 10_000
): Promise<boolean> {
  let settled = false;
  const mark = () => {
    settled = true;
  };
  waiter.settled.then(mark, mark);
  const deadline = Date.now() + timeoutMs;
  while (!settled && Date.now() < deadline) {
    const pid = waiter.pid();
    if (pid !== undefined) {
      const [row] = await getDb().execute<{ blocked: boolean }>(
        sql`SELECT ${holderPid}::int = ANY(pg_blocking_pids(${pid}::int)) AS blocked`
      );
      if (row?.blocked) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

/**
 * A latch: `open()` lets every `passed` waiter through. Open it in a `finally`,
 * so a failed wait cannot leave a transaction holding a lock the cleanup's
 * user delete would then wait on.
 */
export function latch(): { open: () => void; passed: Promise<void> } {
  let open!: () => void;
  const passed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, passed };
}

/** Whether `promise` settles within `ms`. */
export async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const settled = promise.then(
    () => true as const,
    () => true as const
  );
  try {
    return await Promise.race([settled, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Fulfilled, or the SQLSTATE and the server's sentence a transaction was refused with. */
export function outcomeOf(settled: PromiseSettledResult<unknown>): string {
  if (settled.status === 'fulfilled') return 'fulfilled';
  const database = databaseErrorOf(settled.reason) as (Error & { code: string }) | null;
  if (database) return `${database.code} ${database.message}`;
  return settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
}
