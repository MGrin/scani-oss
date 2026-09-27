import { db } from '@scani/db/connection';
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
      (SELECT count(*) FROM holdings WHERE user_id = ${userId}),
      (SELECT base_currency_id::text FROM users WHERE id = ${userId})
    ) AS v
  `)) as unknown as Array<{ v: string }>;
  return row?.v ?? '';
}

export async function sharedReturnsRun<T>(
  requestKey: string,
  userId: string,
  compute: () => Promise<T>,
  readVersion: (userId: string) => Promise<string> = readReturnsDataVersion,
  today: string = new Date().toISOString().slice(0, 10)
): Promise<T> {
  const key = `${requestKey}:${today}:${await readVersion(userId)}`;

  const cached = runs.get(key) as Promise<T> | undefined;
  if (cached) return cached;

  const run = compute();
  runs.set(key, run);
  // A failed run must not be served to the next caller for ten minutes.
  run.catch(() => runs.delete(key));
  return run;
}

/** Test-only: forget every shared run. Not exported from package barrels. */
export function _resetReturnsCache(): void {
  runs.clear();
}
