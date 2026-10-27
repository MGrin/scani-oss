/**
 * A rebuild that reaches past the user's earliest record deletes the rows
 * dated before its own start, and a full rebuild starts where the last one did
 * (SC-1627). Before the fix the rollup counted its own rows as history, so each
 * full rebuild wrote one day older than the oldest stored one, and rows left
 * before the earliest record were never rewritten: on the measured data,
 * thousands of such days across a handful of users, some over a year before
 * the first record.
 *
 * Unstubbed: the rollup's writes autocommit under its advisory lock, so the
 * fixture is real rows, removed after each test.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { and, eq, min } from 'drizzle-orm';
import { Container } from 'typedi';
import { PortfolioValueDailyRepository } from '../../src/repositories/PortfolioValueDailyRepository';
import { RollupPortfolioValueDailyUseCase } from '../../src/use-cases/RollupPortfolioValueDailyUseCase';
import { seedHoldingCache } from '../../test/helpers/engine-guard';

const DAY = 86_400_000;
const RUN_START = new Date('2026-10-04T12:00:00.000Z');
const STALE_DAY = '2026-09-01';

interface Fixture {
  userId: string;
  usdId: string;
  otherBaseId: string;
  accountId: string;
  holdingId: string;
  tokenIds: string[];
  tokenTypeId: string;
  institutionId: string;
  institutionTypeId: string;
  accountTypeId: string;
}

const fixtures: Fixture[] = [];

/** One holding whose only record is a reading on `readAt`, and stale rows on STALE_DAY. */
async function setupFixture(readAt: Date): Promise<Fixture> {
  const [usd] = await db
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .where(eq(schema.tokens.symbol, 'USD'))
    .limit(1);
  if (!usd) throw new Error('USD token not seeded');
  const tag = randomUUID().slice(0, 6);
  const [tokenType] = await db
    .insert(schema.tokenTypes)
    .values({ code: `sc1627-${tag}`, name: 'SC-1627 Token Type' })
    .returning();
  const [user] = await db
    .insert(schema.users)
    .values({ email: `sc1627-${tag}@scani.local`, name: 'SC-1627', baseCurrencyId: usd.id })
    .returning();
  const [institutionType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `sc1627-inst-${tag}`, name: 'SC-1627 Institution Type' })
    .returning();
  const [institution] = await db
    .insert(schema.institutions)
    .values({ name: 'SC-1627 Institution', typeId: institutionType!.id })
    .returning();
  const [accountType] = await db
    .insert(schema.accountTypes)
    .values({ code: `sc1627-acct-${tag}`, name: 'SC-1627 Account Type' })
    .returning();
  const [account] = await db
    .insert(schema.accounts)
    .values({
      userId: user!.id,
      institutionId: institution!.id,
      name: 'SC-1627 Account',
      typeId: accountType!.id,
    })
    .returning();
  const [token, otherBase] = await db
    .insert(schema.tokens)
    .values([
      { symbol: `SC1627${randomUUID().toUpperCase()}`, name: 'SC-1627', typeId: tokenType!.id },
      { symbol: `SC1627B${randomUUID().toUpperCase()}`, name: 'SC-1627 b', typeId: tokenType!.id },
    ])
    .returning();
  const [holding] = await seedHoldingCache(db, (calculator) =>
    calculator
      .insert(schema.holdings)
      .values({
        userId: user!.id,
        accountId: account!.id,
        tokenId: token!.id,
        balance: '10',
        isHidden: false,
        isActive: true,
        createdAt: readAt,
        lastUpdated: readAt,
      })
      .returning()
  );
  await db.insert(schema.holdingBalanceObservations).values({
    userId: user!.id,
    holdingId: holding!.id,
    balance: '10',
    observedAt: readAt,
    source: 'sync-capture',
  });
  const stale = (scopeKind: string, scopeId: string, baseCurrencyId = usd.id) => ({
    userId: user!.id,
    scopeKind,
    scopeId,
    snapshotDate: STALE_DAY,
    baseCurrencyId,
    totalValue: '30',
    coverageQuality: 'full' as const,
    holdingsWithKnownValue: 1,
    holdingsTotal: 1,
  });
  await db
    .insert(schema.portfolioValueDaily)
    .values([
      stale('user', user!.id),
      stale('holding', holding!.id),
      stale('account', account!.id),
      stale('user', user!.id, otherBase!.id),
    ]);
  const fixture: Fixture = {
    userId: user!.id,
    usdId: usd.id,
    otherBaseId: otherBase!.id,
    accountId: account!.id,
    holdingId: holding!.id,
    tokenIds: [token!.id, otherBase!.id],
    tokenTypeId: tokenType!.id,
    institutionId: institution!.id,
    institutionTypeId: institutionType!.id,
    accountTypeId: accountType!.id,
  };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await db
      .delete(schema.portfolioValueDaily)
      .where(eq(schema.portfolioValueDaily.userId, f.userId));
    await db.delete(schema.users).where(eq(schema.users.id, f.userId));
    for (const id of f.tokenIds) await db.delete(schema.tokens).where(eq(schema.tokens.id, id));
    await db.delete(schema.institutions).where(eq(schema.institutions.id, f.institutionId));
    await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, f.accountTypeId));
    await db
      .delete(schema.institutionTypes)
      .where(eq(schema.institutionTypes.id, f.institutionTypeId));
    await db.delete(schema.tokenTypes).where(eq(schema.tokenTypes.id, f.tokenTypeId));
  }
});

const rollup = () => Container.get(RollupPortfolioValueDailyUseCase);

/** The fixture's rows still on STALE_DAY, as `scope_kind/base`. */
async function staleLeft(f: Fixture): Promise<string[]> {
  const rows = await db
    .select({
      scopeKind: schema.portfolioValueDaily.scopeKind,
      base: schema.portfolioValueDaily.baseCurrencyId,
    })
    .from(schema.portfolioValueDaily)
    .where(
      and(
        eq(schema.portfolioValueDaily.userId, f.userId),
        eq(schema.portfolioValueDaily.snapshotDate, STALE_DAY)
      )
    );
  return rows.map((r) => `${r.scopeKind}/${r.base === f.usdId ? 'base' : 'other'}`).sort();
}

async function oldestStoredDay(f: Fixture): Promise<string | null> {
  const [row] = await db
    .select({ day: min(schema.portfolioValueDaily.snapshotDate) })
    .from(schema.portfolioValueDaily)
    .where(
      and(
        eq(schema.portfolioValueDaily.userId, f.userId),
        eq(schema.portfolioValueDaily.baseCurrencyId, f.usdId)
      )
    );
  return row?.day ? String(row.day).slice(0, 10) : null;
}

describe('RollupPortfolioValueDailyUseCase — rows before the earliest record (SC-1627)', () => {
  test('a window reaching past the earliest record deletes every scope before its start, in its base currency', async () => {
    // Earliest record 2026-09-29; a ten-day window starts 2026-09-25.
    const f = await setupFixture(new Date('2026-09-29T08:00:00Z'));
    await rollup().execute({ userId: f.userId, lookbackDays: 10, runStart: RUN_START });
    expect(await staleLeft(f)).toEqual(['user/other']);
    expect(await oldestStoredDay(f)).toBe('2026-09-25');
  });

  test('a window that does not reach the earliest record leaves the older rows alone', async () => {
    // Control: a three-day window starts 2026-10-02, after the reading.
    const f = await setupFixture(new Date('2026-09-29T08:00:00Z'));
    await rollup().execute({ userId: f.userId, lookbackDays: 3, runStart: RUN_START });
    expect(await staleLeft(f)).toEqual(['account/base', 'holding/base', 'user/base', 'user/other']);
  });

  test('a window starting on the earliest record keeps the rows before it', async () => {
    // The day before the first record is the zero a rebuild measures from:
    // only a window that includes it may delete what lies before it.
    const f = await setupFixture(new Date('2026-09-29T08:00:00Z'));
    await rollup().execute({ userId: f.userId, lookbackDays: 6, runStart: RUN_START });
    expect(await staleLeft(f)).toEqual(['account/base', 'holding/base', 'user/base', 'user/other']);
  });

  test('only the call holding the window’s oldest day deletes', async () => {
    const f = await setupFixture(new Date('2026-09-29T08:00:00Z'));
    await rollup().execute({
      userId: f.userId,
      lookbackDays: 10,
      runStart: RUN_START,
      dayOffsets: { from: 0, to: 5 },
    });
    expect(await staleLeft(f)).toHaveLength(4);
    await rollup().execute({
      userId: f.userId,
      lookbackDays: 10,
      runStart: RUN_START,
      dayOffsets: { from: 5, to: 10 },
    });
    expect(await staleLeft(f)).toEqual(['user/other']);
  });

  test('two full rebuilds in a row start on the same day', async () => {
    const runStart = new Date();
    const f = await setupFixture(new Date(runStart.getTime() - 5 * DAY));
    const repo = Container.get(PortfolioValueDailyRepository);
    const first = await repo.findHistoryLookbackDays(f.userId, 3);
    await rollup().execute({ userId: f.userId, lookbackDays: first, runStart });
    const afterFirst = await oldestStoredDay(f);
    const second = await repo.findHistoryLookbackDays(f.userId, 3);
    await rollup().execute({ userId: f.userId, lookbackDays: second, runStart });
    expect(second).toBe(first);
    expect(await oldestStoredDay(f)).toBe(afterFirst);
    expect(afterFirst).toBe(new Date(runStart.getTime() - 6 * DAY).toISOString().slice(0, 10));
  });

  test("a new user's window bounded to their history still clears what lies before it (SC-1765)", async () => {
    // The worker bounds a rebuild with no floor: a day-old record gives three
    // days, one chunk, and the delete above still fires.
    const runStart = new Date();
    const f = await setupFixture(new Date(runStart.getTime() - DAY));
    const lookbackDays = await Container.get(PortfolioValueDailyRepository).findHistoryLookbackDays(
      f.userId,
      1
    );
    expect(lookbackDays).toBe(3);
    await rollup().execute({ userId: f.userId, lookbackDays, runStart });
    expect(await staleLeft(f)).toEqual(['user/other']);
    expect(await oldestStoredDay(f)).toBe(
      new Date(runStart.getTime() - 2 * DAY).toISOString().slice(0, 10)
    );
  });
});
