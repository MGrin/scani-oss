/**
 * Runs `fn` on `tx` with a short `lock_timeout`, and names whoever blocks it.
 *
 * SC-1528: a large-batch test took 120 s on CI against 9 s locally. A slow box
 * and a lock left open by an earlier test in the shard look identical from a
 * bun timeout, and bun does not cancel a timed-out test, so its error is never
 * printed. This turns a lock wait into a fast `55P03`, and a side connection
 * prints each blocker to stderr as soon as it is seen, so the CI log names it
 * even when the test is cut off.
 */

import { type DatabaseTransaction, getDb } from '@scani/db';
import { sql } from 'drizzle-orm';

type Blocker = { pid: number; state: string | null; query: string | null; xactAge: string | null };

export async function withLockWatch<T>(
  tx: DatabaseTransaction,
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
  const [{ pid }] = (await tx.execute(sql`SELECT pg_backend_pid() AS pid`)) as unknown as [
    { pid: number },
  ];
  const seen = new Map<number, Blocker>();
  let running = true;
  const watch = (async () => {
    while (running) {
      const rows = (await getDb().execute(sql`
        SELECT pid, state, left(query, 300) AS query, (now() - xact_start)::text AS "xactAge"
        FROM pg_stat_activity WHERE pid = ANY(pg_blocking_pids(${pid}::int))
      `)) as unknown as Blocker[];
      for (const b of rows) {
        if (seen.has(b.pid)) continue;
        seen.set(b.pid, b);
        console.error(`[lock-watch] ${label}: blocked by pid ${b.pid}`, b);
      }
      await Bun.sleep(250);
    }
  })();
  try {
    return await fn();
  } catch (err) {
    if (seen.size === 0) throw err;
    throw new Error(`${label} was blocked by ${JSON.stringify([...seen.values()])}`, {
      cause: err,
    });
  } finally {
    running = false;
    await watch;
  }
}
