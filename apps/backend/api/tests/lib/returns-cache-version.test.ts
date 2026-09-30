import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { HISTORY_REBUILD_JOB_NAME } from '@scani/shared';
import { eq, sql } from 'drizzle-orm';
import { _resetReturnsCache, sharedReturnsRun } from '../../src/lib/returns-cache';

// SC-1369. `returns-cache.test.ts` injects the version reader; these run the
// REAL one against Postgres, because what changed is the SQL: the rollup part
// of the version is now the newest `computed_at` alone, with no count.
// Committed rows, not a test transaction — the reader uses the shared pool,
// which cannot see an uncommitted write.

const suffix = randomUUID().slice(0, 8);
let userId: string;
let baseId: string;
let tokenTypeId: string;

function counter() {
  let runs = 0;
  return {
    compute: async () => {
      runs += 1;
      return runs;
    },
    runs: () => runs,
  };
}

async function rollupRow(snapshotDate: string, computedAt: Date) {
  await db
    .insert(schema.portfolioValueDaily)
    .values({
      userId,
      scopeKind: 'user',
      scopeId: userId,
      snapshotDate,
      baseCurrencyId: baseId,
      totalValue: '100',
      coverageQuality: 'full',
      holdingsWithKnownValue: 1,
      holdingsTotal: 1,
      computedAt,
    })
    .onConflictDoUpdate({
      target: [
        schema.portfolioValueDaily.userId,
        schema.portfolioValueDaily.scopeKind,
        schema.portfolioValueDaily.scopeId,
        schema.portfolioValueDaily.snapshotDate,
        schema.portfolioValueDaily.baseCurrencyId,
      ],
      set: { computedAt, totalValue: sql`excluded.total_value` },
    });
}

beforeAll(async () => {
  const [type] = await db
    .insert(schema.tokenTypes)
    .values({ code: `sc1369-${suffix}`, name: `SC-1369 ${suffix}` })
    .returning();
  if (!type) throw new Error('token type insert failed');
  tokenTypeId = type.id;
  const [token] = await db
    .insert(schema.tokens)
    .values({ symbol: `SC1369${suffix}`, name: 'SC-1369 base', typeId: tokenTypeId })
    .returning();
  if (!token) throw new Error('token insert failed');
  baseId = token.id;
  const [user] = await db
    .insert(schema.users)
    .values({ email: `sc1369-${suffix}@scani.local`, name: 'sc1369', baseCurrencyId: baseId })
    .returning();
  if (!user) throw new Error('user insert failed');
  userId = user.id;
  await rollupRow('2026-03-01', new Date('2026-03-02T04:00:00Z'));
});

afterAll(async () => {
  await db.delete(schema.users).where(eq(schema.users.id, userId));
  await db.delete(schema.tokens).where(eq(schema.tokens.id, baseId));
  await db.delete(schema.tokenTypes).where(eq(schema.tokenTypes.id, tokenTypeId));
});

beforeEach(() => _resetReturnsCache());

describe('sharedReturnsRun with the real data version (SC-1369)', () => {
  test('unchanged data shares one run — the control the two below are read against', async () => {
    const c = counter();
    await sharedReturnsRun('k', userId, c.compute);
    await sharedReturnsRun('k', userId, c.compute);
    expect(c.runs()).toBe(1);
  });

  test('a rollup row rewritten with a newer computed_at computes again', async () => {
    const c = counter();
    await sharedReturnsRun('k', userId, c.compute);
    await rollupRow('2026-03-01', new Date('2026-03-03T04:00:00Z'));
    await sharedReturnsRun('k', userId, c.compute);
    expect(c.runs()).toBe(2);
  });

  test('a new rollup day computes again', async () => {
    const c = counter();
    await sharedReturnsRun('k', userId, c.compute);
    await rollupRow('2026-03-02', new Date('2026-03-04T04:00:00Z'));
    await sharedReturnsRun('k', userId, c.compute);
    expect(c.runs()).toBe(2);
  });

  // SC-1396: returns reads a queued history recompute as "rebuilding". A
  // result cached before it must not be served while it waits, and the
  // "rebuilding" result must not be served once it has finished.
  test('a pending history recompute is its own version, in both directions', async () => {
    const c = counter();
    expect(await sharedReturnsRun('k', userId, c.compute)).toBe(1);
    const jobId = `rebuild-${suffix}`;
    await db.insert(schema.userJobs).values({
      jobId,
      userId,
      jobName: HISTORY_REBUILD_JOB_NAME,
      state: 'queued',
    });
    expect(await sharedReturnsRun('k', userId, c.compute)).toBe(2);
    await db
      .update(schema.userJobs)
      .set({ state: 'completed' })
      .where(eq(schema.userJobs.jobId, jobId));
    expect(await sharedReturnsRun('k', userId, c.compute)).not.toBe(2);
  });
});
