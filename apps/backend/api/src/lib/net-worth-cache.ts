import { db } from '@scani/db/connection';
import { notScamFor } from '@scani/domain/lib/scam-verdict';
import { sql } from 'drizzle-orm';
import { LruCache } from './lru-cache';
import { type AggregatedDailyPoint, userNetWorthDaily } from './net-worth-series';

const NET_WORTH_CACHE_TTL_MS = 10 * 60 * 1000;

const series = new LruCache<string, Promise<AggregatedDailyPoint[]>>({
  maxEntries: 500,
  ttlMs: NET_WORTH_CACHE_TTL_MS,
});

async function readNetWorthVersion(userId: string): Promise<string> {
  const [row] = (await db.execute<{ v: string }>(sql`
    SELECT concat_ws('|',
      (SELECT coalesce(max(computed_at)::text, '') FROM portfolio_value_daily WHERE user_id = ${userId}),
      (SELECT coalesce(md5(string_agg(h.id::text, ',' ORDER BY h.id)), '')
         FROM holdings h JOIN tokens t ON t.id = h.token_id
        WHERE h.user_id = ${userId} AND NOT h.is_hidden AND h.is_active AND ${notScamFor('h', 't')})
    ) AS v
  `)) as unknown as Array<{ v: string }>;
  return row?.v ?? '';
}

export async function cachedUserNetWorthDaily(
  userId: string,
  baseCurrencyId: string,
  from: Date,
  to: Date,
  readVersion: (userId: string) => Promise<string> = readNetWorthVersion,
  compute: typeof userNetWorthDaily = userNetWorthDaily
): Promise<AggregatedDailyPoint[]> {
  // The read slices both bounds to a date, so two instants on the same days
  // are the same question.
  const days = `${from.toISOString().slice(0, 10)}:${to.toISOString().slice(0, 10)}`;
  const key = `${userId}:${baseCurrencyId}:${days}:${await readVersion(userId)}`;

  const cached = series.get(key);
  if (cached) return cached;

  const run = compute(userId, baseCurrencyId, from, to);
  series.set(key, run);
  run.catch(() => series.delete(key));
  return run;
}

/** Test-only: forget every cached series. Not exported from package barrels. */
export function _resetNetWorthCache(): void {
  series.clear();
}
