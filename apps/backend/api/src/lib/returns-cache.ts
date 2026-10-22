import { db } from '@scani/db/connection';
import { HISTORY_REBUILD_JOB_NAME } from '@scani/shared';
import { type SQL, sql } from 'drizzle-orm';
import { LruCache } from './lru-cache';

// The key moves with the data version and the UTC day, which is everything the
// answer reads: inside a day `now` only values today's flows, as the rollup
// that set the version did. Ten minutes made every Home load after a gap cold,
// 4.7-8.9 s on production (SC-1745); a day bounds only memory, with the LRU.
const RETURNS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const runs = new LruCache<string, Promise<unknown>>({
  maxEntries: 500,
  ttlMs: RETURNS_CACHE_TTL_MS,
});

/**
 * The statement behind a user's returns data version; one row, column `v`.
 *
 * Observations are read as their newest write and review, with no count
 * (SC-1741): nothing deletes an observation but the cascade from its holding
 * or user, and the holdings part already moves when a holding goes.
 */
export function returnsDataVersionSql(userId: string): SQL {
  return sql`
    SELECT concat_ws('|',
      (SELECT count(*) || ':' || coalesce(max(updated_at)::text, '') FROM holding_transactions WHERE user_id = ${userId}),
      (SELECT coalesce(max(computed_at)::text, '') FROM portfolio_value_daily WHERE user_id = ${userId}),
      (SELECT count(*) || ':' || coalesce(max(last_updated)::text, '') FROM holdings WHERE user_id = ${userId}),
      (SELECT coalesce(max(c.updated_at)::text, '') FROM holding_coverage c JOIN holdings h ON h.id = c.holding_id WHERE h.user_id = ${userId}),
      (SELECT coalesce(max(created_at)::text, '') FROM holding_balance_observations WHERE user_id = ${userId}) || ':' ||
        (SELECT coalesce(max(gap_reviewed_at)::text, '') FROM holding_balance_observations WHERE user_id = ${userId}),
      (SELECT base_currency_id::text FROM users WHERE id = ${userId}),
      (SELECT coalesce(string_agg(job_id, ',' ORDER BY job_id), '') FROM user_jobs WHERE user_id = ${userId} AND job_name = ${HISTORY_REBUILD_JOB_NAME} AND state IN ('queued', 'active', 'progress'))
    ) AS v
  `;
}

async function readReturnsDataVersion(userId: string): Promise<string> {
  const [row] = (await db.execute<{ v: string }>(
    returnsDataVersionSql(userId)
  )) as unknown as Array<{ v: string }>;
  return row?.v ?? '';
}

export async function sharedReturnsRun<T>(
  requestKey: string,
  userId: string,
  /**
   * Gets the user's data key, `user:day:version`: the windows a Home load asks
   * for share their loads under it, and a write changes it (SC-1671).
   */
  compute: (dataKey: string) => Promise<T>,
  readVersion: (userId: string) => Promise<string> = readReturnsDataVersion,
  today: string = new Date().toISOString().slice(0, 10),
  /**
   * The version read is the call's first query, so its time is what a cold
   * database adds; a hit pays nothing else (SC-1745).
   */
  observe?: (o: { hit: boolean; versionMs: number }) => void
): Promise<T> {
  const started = performance.now();
  const version = await readVersion(userId);
  const versionMs = Math.round(performance.now() - started);
  const dataKey = `${userId}:${today}:${version}`;
  const key = `${requestKey}:${dataKey}`;

  const cached = runs.get(key) as Promise<T> | undefined;
  observe?.({ hit: cached !== undefined, versionMs });
  if (cached) return cached;

  const run = compute(dataKey);
  runs.set(key, run);
  // A failed run must not be served to the next caller for the rest of the day.
  run.catch(() => runs.delete(key));
  return run;
}

/** Test-only: forget every shared run. Not exported from package barrels. */
export function _resetReturnsCache(): void {
  runs.clear();
}
