import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { _resetNetWorthCache, cachedUserNetWorthDaily } from '../../src/lib/net-worth-cache';
import type { AggregatedDailyPoint } from '../../src/lib/net-worth-series';

// SC-1369. The first block injects the version reader; the second runs the
// REAL one against Postgres, with committed rows — the reader uses the shared
// pool, which cannot see an uncommitted write.

function counter() {
  let runs = 0;
  return {
    compute: async (): Promise<AggregatedDailyPoint[]> => {
      runs += 1;
      return [];
    },
    runs: () => runs,
  };
}

const FROM = new Date('2026-08-27T07:04:46.986Z');
const TO = new Date('2026-09-26T07:04:46.986Z');

beforeEach(() => _resetNetWorthCache());

describe('cachedUserNetWorthDaily', () => {
  const fixed = async () => 'v1';

  test('the same window under the same version computes once', async () => {
    const c = counter();
    await cachedUserNetWorthDaily('u', 'b', FROM, TO, fixed, c.compute);
    await cachedUserNetWorthDaily('u', 'b', FROM, TO, fixed, c.compute);
    expect(c.runs()).toBe(1);
  });

  test('a reload seconds later asks the same days, so it is served from the cache', async () => {
    const c = counter();
    await cachedUserNetWorthDaily('u', 'b', FROM, TO, fixed, c.compute);
    const later = (d: Date) => new Date(d.getTime() + 15_000);
    await cachedUserNetWorthDaily('u', 'b', later(FROM), later(TO), fixed, c.compute);
    expect(c.runs()).toBe(1);
  });

  test('a different version computes again', async () => {
    const c = counter();
    await cachedUserNetWorthDaily('u', 'b', FROM, TO, fixed, c.compute);
    await cachedUserNetWorthDaily('u', 'b', FROM, TO, async () => 'v2', c.compute);
    expect(c.runs()).toBe(2);
  });

  test('a failed read is not served to the next caller', async () => {
    let calls = 0;
    const failing = async (): Promise<AggregatedDailyPoint[]> => {
      calls += 1;
      throw new Error('db down');
    };
    await expect(cachedUserNetWorthDaily('u', 'b', FROM, TO, fixed, failing)).rejects.toThrow();
    await expect(cachedUserNetWorthDaily('u', 'b', FROM, TO, fixed, failing)).rejects.toThrow();
    expect(calls).toBe(2);
  });
});

describe('cachedUserNetWorthDaily with the real data version', () => {
  const suffix = randomUUID().slice(0, 8);
  let userId: string;
  let tokenTypeId: string;
  let baseId: string;
  let heldId: string;
  let institutionTypeId: string;
  let institutionId: string;
  let accountTypeId: string;
  let holdingId: string;

  const run = (c: ReturnType<typeof counter>) =>
    cachedUserNetWorthDaily(userId, baseId, FROM, TO, undefined, c.compute);

  beforeAll(async () => {
    const [type] = await db
      .insert(schema.tokenTypes)
      .values({ code: `sc1369nw-${suffix}`, name: `SC-1369 nw ${suffix}` })
      .returning();
    tokenTypeId = type!.id;
    const tokens = await db
      .insert(schema.tokens)
      .values([
        { symbol: `NWB${suffix}`, name: 'SC-1369 base', typeId: tokenTypeId },
        { symbol: `NWH${suffix}`, name: 'SC-1369 held', typeId: tokenTypeId },
      ])
      .returning();
    baseId = tokens[0]!.id;
    heldId = tokens[1]!.id;
    const [user] = await db
      .insert(schema.users)
      .values({ email: `sc1369nw-${suffix}@scani.local`, name: 'sc1369nw', baseCurrencyId: baseId })
      .returning();
    userId = user!.id;
    const [institutionType] = await db
      .insert(schema.institutionTypes)
      .values({ code: `sc1369nw-${suffix}`, name: 'SC-1369 type' })
      .returning();
    institutionTypeId = institutionType!.id;
    const [institution] = await db
      .insert(schema.institutions)
      .values({ name: `SC-1369 ${suffix}`, typeId: institutionTypeId })
      .returning();
    institutionId = institution!.id;
    const [accountType] = await db
      .insert(schema.accountTypes)
      .values({ code: `sc1369nw-acct-${suffix}`, name: 'SC-1369 account type' })
      .returning();
    accountTypeId = accountType!.id;
    const [account] = await db
      .insert(schema.accounts)
      .values({ userId, institutionId, name: 'SC-1369', typeId: accountTypeId })
      .returning();
    const [holding] = await db
      .insert(schema.holdings)
      .values({ userId, accountId: account!.id, tokenId: heldId, balance: '1' })
      .returning();
    holdingId = holding!.id;
  });

  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, accountTypeId));
    await db.delete(schema.institutions).where(eq(schema.institutions.id, institutionId));
    await db
      .delete(schema.institutionTypes)
      .where(eq(schema.institutionTypes.id, institutionTypeId));
    await db.delete(schema.tokens).where(inArray(schema.tokens.id, [baseId, heldId]));
    await db.delete(schema.tokenTypes).where(eq(schema.tokenTypes.id, tokenTypeId));
  });

  const setHolding = (values: { isHidden?: boolean; isActive?: boolean }) =>
    db.update(schema.holdings).set(values).where(eq(schema.holdings.id, holdingId));

  test('unchanged data computes once — the control the three below are read against', async () => {
    const c = counter();
    await run(c);
    await run(c);
    expect(c.runs()).toBe(1);
  });

  test('hiding a holding computes again', async () => {
    const c = counter();
    await run(c);
    await setHolding({ isHidden: true });
    await run(c);
    await setHolding({ isHidden: false });
    expect(c.runs()).toBe(2);
  });

  test('deactivating a holding computes again', async () => {
    const c = counter();
    await run(c);
    await setHolding({ isActive: false });
    await run(c);
    await setHolding({ isActive: true });
    expect(c.runs()).toBe(2);
  });

  test('a rollup row written with a newer computed_at computes again', async () => {
    const c = counter();
    await run(c);
    await db.insert(schema.portfolioValueDaily).values({
      userId,
      scopeKind: 'holding',
      scopeId: holdingId,
      snapshotDate: '2026-09-20',
      baseCurrencyId: baseId,
      totalValue: '100',
      coverageQuality: 'full',
      holdingsWithKnownValue: 1,
      holdingsTotal: 1,
      computedAt: new Date(),
    });
    await run(c);
    expect(c.runs()).toBe(2);
  });
});

describe('cachedUserNetWorthDaily returns the NEW answer when its input changes', () => {
  // The block above proves a change computes again with a counter. These run
  // the real read, so they prove the next call returns the new series and not
  // the cached one: a cache is only right if it goes stale with its answer.
  const suffix = randomUUID().slice(0, 8);
  let userId: string;
  let tokenTypeId: string;
  let baseId: string;
  let heldId: string;
  let institutionTypeId: string;
  let institutionId: string;
  let accountTypeId: string;
  let holdingId: string;

  const series = async () =>
    (await cachedUserNetWorthDaily(userId, baseId, FROM, TO)).map(
      (p) => `${p.snapshotDate}=${p.totalValue}`
    );
  const setHolding = (values: { isHidden?: boolean; isActive?: boolean }) =>
    db.update(schema.holdings).set(values).where(eq(schema.holdings.id, holdingId));
  const writeRollup = (totalValue: string) =>
    db
      .insert(schema.portfolioValueDaily)
      .values({
        userId,
        scopeKind: 'holding',
        scopeId: holdingId,
        snapshotDate: '2026-09-20',
        baseCurrencyId: baseId,
        totalValue,
        coverageQuality: 'full',
        holdingsWithKnownValue: 1,
        holdingsTotal: 1,
        computedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          schema.portfolioValueDaily.userId,
          schema.portfolioValueDaily.scopeKind,
          schema.portfolioValueDaily.scopeId,
          schema.portfolioValueDaily.snapshotDate,
          schema.portfolioValueDaily.baseCurrencyId,
        ],
        set: { totalValue, computedAt: new Date() },
      });

  beforeAll(async () => {
    const [type] = await db
      .insert(schema.tokenTypes)
      .values({ code: `sc1369nv-${suffix}`, name: `SC-1369 nv ${suffix}` })
      .returning();
    tokenTypeId = type!.id;
    const tokens = await db
      .insert(schema.tokens)
      .values([
        { symbol: `NVB${suffix}`, name: 'SC-1369 base', typeId: tokenTypeId },
        { symbol: `NVH${suffix}`, name: 'SC-1369 held', typeId: tokenTypeId },
      ])
      .returning();
    baseId = tokens[0]!.id;
    heldId = tokens[1]!.id;
    const [user] = await db
      .insert(schema.users)
      .values({ email: `sc1369nv-${suffix}@scani.local`, name: 'sc1369nv', baseCurrencyId: baseId })
      .returning();
    userId = user!.id;
    const [institutionType] = await db
      .insert(schema.institutionTypes)
      .values({ code: `sc1369nv-${suffix}`, name: 'SC-1369 type' })
      .returning();
    institutionTypeId = institutionType!.id;
    const [institution] = await db
      .insert(schema.institutions)
      .values({ name: `SC-1369 nv ${suffix}`, typeId: institutionTypeId })
      .returning();
    institutionId = institution!.id;
    const [accountType] = await db
      .insert(schema.accountTypes)
      .values({ code: `sc1369nv-acct-${suffix}`, name: 'SC-1369 account type' })
      .returning();
    accountTypeId = accountType!.id;
    const [account] = await db
      .insert(schema.accounts)
      .values({ userId, institutionId, name: 'SC-1369 nv', typeId: accountTypeId })
      .returning();
    const [holding] = await db
      .insert(schema.holdings)
      .values({ userId, accountId: account!.id, tokenId: heldId, balance: '1' })
      .returning();
    holdingId = holding!.id;
    await writeRollup('100');
  });

  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, accountTypeId));
    await db.delete(schema.institutions).where(eq(schema.institutions.id, institutionId));
    await db
      .delete(schema.institutionTypes)
      .where(eq(schema.institutionTypes.id, institutionTypeId));
    await db.delete(schema.tokens).where(inArray(schema.tokens.id, [baseId, heldId]));
    await db.delete(schema.tokenTypes).where(eq(schema.tokenTypes.id, tokenTypeId));
  });

  test('excluding a holding drops its value; including it again brings it back', async () => {
    expect(await series()).toEqual(['2026-09-20=100']);
    await setHolding({ isHidden: true });
    expect(await series()).toEqual([]);
    await setHolding({ isHidden: false });
    expect(await series()).toEqual(['2026-09-20=100']);
    await setHolding({ isActive: false });
    expect(await series()).toEqual([]);
    await setHolding({ isActive: true });
    expect(await series()).toEqual(['2026-09-20=100']);
  });

  test('a rollup recompute is served on the next call', async () => {
    expect(await series()).toEqual(['2026-09-20=100']);
    await writeRollup('250');
    expect(await series()).toEqual(['2026-09-20=250']);
    await writeRollup('100');
  });
});
