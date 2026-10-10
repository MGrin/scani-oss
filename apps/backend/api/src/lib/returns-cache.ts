import { db } from '@scani/db/connection';
import { HISTORY_REBUILD_JOB_NAME } from '@scani/shared';
import { sql } from 'drizzle-orm';
import { LruCache } from './lru-cache';

const RETURNS_CACHE_TTL_MS = 10 * 60 * 1000;

const runs = new LruCache<string, Promise<unknown>>({
  maxEntries: 500,
  ttlMs: RETURNS_CACHE_TTL_MS,
});

async function readReturnsDataVersion(userId: string): Promise<string> {
  const [row] = (await db.execute<{ v: string }>(sql`
    SELECT concat_ws('|',
      (SELECT count(*) || ':' || coalesce(max(updated_at)::text, '') FROM holding_transactions WHERE user_id = ${userId}),
      (SELECT coalesce(max(computed_at)::text, '') FROM portfolio_value_daily WHERE user_id = ${userId}),
      (SELECT count(*) || ':' || coalesce(max(last_updated)::text, '') FROM holdings WHERE user_id = ${userId}),
      (SELECT coalesce(max(c.updated_at)::text, '') FROM holding_coverage c JOIN holdings h ON h.id = c.holding_id WHERE h.user_id = ${userId}),
      (SELECT count(*) || ':' || coalesce(max(created_at)::text, '') || ':' || coalesce(max(gap_reviewed_at)::text, '') FROM holding_balance_observations WHERE user_id = ${userId}),
      (SELECT base_currency_id::text FROM users WHERE id = ${userId}),
      (SELECT coalesce(string_agg(job_id, ',' ORDER BY job_id), '') FROM user_jobs WHERE user_id = ${userId} AND job_name = ${HISTORY_REBUILD_JOB_NAME} AND state IN ('queued', 'active', 'progress'))
    ) AS v
  `)) as unknown as Array<{ v: string }>;
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
  today: string = new Date().toISOString().slice(0, 10)
): Promise<T> {
  const dataKey = `${userId}:${today}:${await readVersion(userId)}`;
  const key = `${requestKey}:${dataKey}`;

  const cached = runs.get(key) as Promise<T> | undefined;
  if (cached) return cached;

  const run = compute(dataKey);
  runs.set(key, run);
  // A failed run must not be served to the next caller for ten minutes.
  run.catch(() => runs.delete(key));
  return run;
}

/** Test-only: forget every shared run. Not exported from package barrels. */
export function _resetReturnsCache(): void {
  runs.clear();
}
