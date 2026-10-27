import { db } from '@scani/db/connection';
import { createComponentLogger } from '@scani/logging';
import { getSharedRedis } from '@scani/rate-limiter';
import { HISTORY_REBUILD_JOB_NAME } from '@scani/shared';
import { type SQL, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import type { ReturnWindowRequest } from '../../lib/returns/window';
import type { ReturnsScope } from './ReturnsScopeResolver';
import { type ReturnsOutcome, ReturnsService } from './ReturnsService';
import { ReturnsSharedLoads } from './ReturnsSharedLoads';

const log = createComponentLogger('returns-answer-cache');

/**
 * The windows Home asks for on every open (ReturnsBlock: all and 1y, the tile
 * ytd), user-wide. These are what the worker computes ahead of the reader.
 */
export const HOME_RETURNS_WINDOWS: ReturnWindowRequest[] = [
  { kind: 'all' },
  { kind: '1y' },
  { kind: 'ytd' },
];

const USER_SCOPE: ReturnsScope = { kind: 'user' };

/** One request's identity, before the data it reads: scope and window. */
export function returnsRequestKey(request: {
  userId: string;
  scope: ReturnsScope;
  window: ReturnWindowRequest;
}): string {
  return `returns:${request.userId}:${JSON.stringify(request.scope)}:${windowKey(request.window)}`;
}

/**
 * Where a request's last good answer is kept, whatever data it was computed
 * on: what Home is shown at once, marked stale, while the answer for the
 * current data is computed (SC-1745).
 */
export function returnsLatestKey(requestKey: string): string {
  return `${requestKey}:latest`;
}

function windowKey(window: ReturnWindowRequest): string {
  if (window.kind !== 'custom') return JSON.stringify(window);
  return `custom:${window.from.toISOString().slice(0, 10)}:${window.to.toISOString().slice(0, 10)}`;
}

/** `user:day:version`: everything an answer reads besides its request. */
export function returnsDataKey(userId: string, version: string, today: string): string {
  return `${userId}:${today}:${version}`;
}

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

export async function readReturnsDataVersion(userId: string): Promise<string> {
  const [row] = (await db.execute<{ v: string }>(
    returnsDataVersionSql(userId)
  )) as unknown as Array<{ v: string }>;
  return row?.v ?? '';
}

/** Answers shared by every API machine and the worker, keyed as the API keys them. */
export interface ReturnsAnswerStore {
  get(key: string): Promise<ReturnsOutcome | undefined>;
  set(key: string, outcome: ReturnsOutcome): Promise<void>;
}

// The key already moves with the data and the UTC day; this bounds memory.
const ANSWER_TTL_S = 24 * 60 * 60;

/**
 * Redis, because each API process kept its own cache: two machines, and a
 * deploy, each started cold (SC-1745). With no Redis it holds nothing, and a
 * Redis error reads as a miss: the answer is always computable without it.
 */
export class RedisReturnsAnswerStore implements ReturnsAnswerStore {
  async get(key: string): Promise<ReturnsOutcome | undefined> {
    const redis = getSharedRedis();
    if (!redis) return undefined;
    try {
      const raw = await redis.get(`${key}:answer`);
      return raw === null ? undefined : (JSON.parse(raw) as ReturnsOutcome);
    } catch (error) {
      log.warn({ err: error }, 'returns answer read failed; computing');
      return undefined;
    }
  }

  async set(key: string, outcome: ReturnsOutcome): Promise<void> {
    const redis = getSharedRedis();
    if (!redis) return;
    try {
      await redis.set(`${key}:answer`, JSON.stringify(outcome), 'EX', ANSWER_TTL_S);
    } catch (error) {
      log.warn({ err: error }, 'returns answer write failed');
    }
  }
}

// Only readers who open the app get the work done for them (operator bound,
// SC-1745): an app open is recorded as its refresh job.
const ACTIVE_DAYS = 14;

async function openedAppRecently(userId: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT 1 FROM user_jobs
     WHERE user_id = ${userId} AND job_name = 'app-open-refresh'
       AND created_at > now() - make_interval(days => ${ACTIVE_DAYS})
     LIMIT 1
  `)) as unknown as unknown[];
  return rows.length > 0;
}

export interface ReturnsPrecomputeDeps {
  store: ReturnsAnswerStore;
  isActive: (userId: string) => Promise<boolean>;
  readVersion: (userId: string) => Promise<string>;
  compute: (
    request: { userId: string; scope: ReturnsScope; window: ReturnWindowRequest },
    shared: ReturnsSharedLoads
  ) => Promise<ReturnsOutcome>;
  today: () => string;
}

const defaultDeps = (): ReturnsPrecomputeDeps => ({
  store: new RedisReturnsAnswerStore(),
  isActive: openedAppRecently,
  readVersion: readReturnsDataVersion,
  compute: (request, shared) => Container.get(ReturnsService).compute(request, { shared }),
  today: () => new Date().toISOString().slice(0, 10),
});

export interface ReturnsPrecomputeOutcome {
  skipped?: 'inactive';
  computed: number;
  alreadyStored: number;
}

/**
 * Computes Home's returns under the user's current data version and stores
 * them where the API reads first (SC-1745). The API keyed its cache on that
 * version, and an app open moved it within seconds: the 13 balance refreshes
 * it starts write holdings, and so do the hourly prices and rollup. So most
 * Home loads paid the cold compute, 3 s p50. A window already stored under the
 * current version is not computed again.
 */
export async function precomputeHomeReturns(
  userId: string,
  deps: ReturnsPrecomputeDeps = defaultDeps()
): Promise<ReturnsPrecomputeOutcome> {
  if (!(await deps.isActive(userId))) return { skipped: 'inactive', computed: 0, alreadyStored: 0 };
  const dataKey = returnsDataKey(userId, await deps.readVersion(userId), deps.today());
  const shared = new ReturnsSharedLoads();
  let computed = 0;
  let alreadyStored = 0;
  for (const window of HOME_RETURNS_WINDOWS) {
    const requestKey = returnsRequestKey({ userId, scope: USER_SCOPE, window });
    const key = `${requestKey}:${dataKey}`;
    const stored = await deps.store.get(key);
    if (stored) {
      await deps.store.set(returnsLatestKey(requestKey), stored);
      alreadyStored += 1;
      continue;
    }
    const outcome = await deps.compute({ userId, scope: USER_SCOPE, window }, shared);
    if (outcome.status === 'ok') {
      await deps.store.set(key, outcome);
      await deps.store.set(returnsLatestKey(requestKey), outcome);
    }
    computed += 1;
  }
  return { computed, alreadyStored };
}
