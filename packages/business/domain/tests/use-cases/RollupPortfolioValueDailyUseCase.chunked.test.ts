/**
 * SC-1283. A window rolled up in chunks must write exactly the rows a single
 * pass writes. The portfolio-history backfill walks 400 days in 30-day steps
 * so its memory stays at one step's worth; that is only a fix if nothing the
 * chart reads moves.
 *
 * Unstubbed on purpose — real valuation, cost basis and price graph — so the
 * comparison covers every column the rollup computes, not a stub's echo.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import type { EngineEvidenceRepository } from '../../src/repositories/EngineEvidenceRepository';
import type { BalanceAtTimeService } from '../../src/services/pricing/BalanceAtTimeService';
import { RollupPortfolioValueDailyUseCase } from '../../src/use-cases/RollupPortfolioValueDailyUseCase';
import { seedHoldingCache } from '../../test/helpers/engine-guard';

// Two of these roll 70 days up twice through real valuation: 12s median on
// main's CI, 23.3s at worst, and one red at 30.4s under a shared runner (SC-1593).
setDefaultTimeout(90_000);

const DAY = 86_400_000;
const LOOKBACK = 70;
const OBSERVED_HOURS = 50 * 24;

interface Fixture {
  userId: string;
  tokenTypeId: string;
  tokenIds: string[];
  institutionId: string;
  institutionTypeId: string;
  accountTypeId: string;
}

let fixture: Fixture;

async function setupFixture(): Promise<Fixture> {
  const [usd] = await db
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .where(eq(schema.tokens.symbol, 'USD'))
    .limit(1);
  if (!usd) throw new Error('USD token not seeded');

  const [tokenType] = await db
    .insert(schema.tokenTypes)
    .values({ code: `rpvc-${randomUUID().slice(0, 6)}`, name: 'RPVC Token Type' })
    .returning();
  const [user] = await db
    .insert(schema.users)
    .values({
      email: `rpvc-${randomUUID().slice(0, 8)}@scani.local`,
      name: 'RPVC User',
      baseCurrencyId: usd.id,
    })
    .returning();
  const [institutionType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `rpvc-inst-${randomUUID().slice(0, 6)}`, name: 'RPVC Institution Type' })
    .returning();
  const [institution] = await db
    .insert(schema.institutions)
    .values({ name: 'RPVC Institution', typeId: institutionType!.id })
    .returning();
  const [accountType] = await db
    .insert(schema.accountTypes)
    .values({ code: `rpvc-acct-${randomUUID().slice(0, 6)}`, name: 'RPVC Account Type' })
    .returning();
  const [account] = await db
    .insert(schema.accounts)
    .values({
      userId: user!.id,
      institutionId: institution!.id,
      name: 'RPVC Account',
      typeId: accountType!.id,
    })
    .returning();

  // Two assets priced daily across the window, bought and partly sold inside
  // it, so value, cost basis and realized PnL all change from chunk to chunk.
  const today = Math.floor(Date.now() / DAY) * DAY;
  const tokenIds: string[] = [];
  for (const [n, p0] of [
    [0, 100],
    [1, 2500],
  ] as const) {
    const [token] = await db
      .insert(schema.tokens)
      .values({
        symbol: `RPVC${n}${randomUUID().toUpperCase()}`,
        name: `RPVC Asset ${n}`,
        typeId: tokenType!.id,
      })
      .returning();
    tokenIds.push(token!.id);
    await db.insert(schema.tokenPrices).values(
      Array.from({ length: LOOKBACK + 20 }, (_, i) => ({
        tokenId: token!.id,
        baseTokenId: usd.id,
        price: (p0 * (1 + 0.01 * ((i * 7) % 11))).toFixed(4),
        timestamp: new Date(today - i * DAY),
        granularity: 'daily' as const,
        source: 'rpvc-test',
      }))
    );
    const [holding] = await seedHoldingCache(db, (calculator) =>
      calculator
        .insert(schema.holdings)
        .values({ userId: user!.id, accountId: account!.id, tokenId: token!.id, balance: '7' })
        .returning()
    );
    await db.insert(schema.holdingTransactions).values(
      [
        { kind: 'buy', quantity: '10', daysAgo: 60 },
        { kind: 'sell', quantity: '-4', daysAgo: 35 },
        { kind: 'buy', quantity: '1', daysAgo: 12 },
      ].map((t, k) => ({
        userId: user!.id,
        holdingId: holding!.id,
        tokenId: token!.id,
        kind: t.kind,
        quantity: t.quantity,
        priceNative: String(p0 + k),
        priceNativeTokenId: usd.id,
        occurredAt: new Date(today - t.daysAgo * DAY + 3_600_000),
        externalId: `rpvc-${n}-${k}`,
        source: 'rpvc-test',
      }))
    );
    // Hourly sync-captures over the last 50 days, drifting a little from the
    // ledger, so days resolve through observation anchors and interpolation
    // rather than the holding row alone. Prod carries 112k of these (SC-1283).
    const ledgerAt = (daysAgo: number) => (daysAgo > 35 ? 10 : daysAgo > 12 ? 6 : 7);
    await db.insert(schema.holdingBalanceObservations).values(
      Array.from({ length: OBSERVED_HOURS }, (_, h) => {
        const hoursAgo = OBSERVED_HOURS - h;
        return {
          userId: user!.id,
          holdingId: holding!.id,
          balance: (ledgerAt(hoursAgo / 24) + h / 10_000).toFixed(6),
          observedAt: new Date(today - hoursAgo * 3_600_000 + 1_800_000),
          source: 'sync-capture',
        };
      })
    );
  }

  return {
    userId: user!.id,
    tokenTypeId: tokenType!.id,
    tokenIds,
    institutionId: institution!.id,
    institutionTypeId: institutionType!.id,
    accountTypeId: accountType!.id,
  };
}

async function cleanupFixture(f: Fixture): Promise<void> {
  await db
    .delete(schema.portfolioValueDaily)
    .where(eq(schema.portfolioValueDaily.userId, f.userId));
  await db.delete(schema.users).where(eq(schema.users.id, f.userId));
  await db.delete(schema.tokenPrices).where(inArray(schema.tokenPrices.tokenId, f.tokenIds));
  await db.delete(schema.tokens).where(inArray(schema.tokens.id, f.tokenIds));
  await db.delete(schema.institutions).where(eq(schema.institutions.id, f.institutionId));
  await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, f.accountTypeId));
  await db
    .delete(schema.institutionTypes)
    .where(eq(schema.institutionTypes.id, f.institutionTypeId));
  await db.delete(schema.tokenTypes).where(eq(schema.tokenTypes.id, f.tokenTypeId));
}

// Every column the rollup computes; `computedAt` is when, not what.
async function readRows(userId: string): Promise<Record<string, unknown>[]> {
  const rows = await db
    .select()
    .from(schema.portfolioValueDaily)
    .where(eq(schema.portfolioValueDaily.userId, userId));
  return rows
    .map(({ computedAt: _computedAt, ...rest }) => rest)
    .sort((a, b) =>
      `${a.snapshotDate}|${a.scopeKind}|${a.scopeId}`.localeCompare(
        `${b.snapshotDate}|${b.scopeKind}|${b.scopeId}`
      )
    );
}

beforeAll(async () => {
  fixture = await setupFixture();
});

afterAll(async () => {
  await cleanupFixture(fixture);
});

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

async function clearRows(): Promise<void> {
  await db
    .delete(schema.portfolioValueDaily)
    .where(eq(schema.portfolioValueDaily.userId, fixture.userId));
}

describe('RollupPortfolioValueDailyUseCase — chunked window (SC-1283)', () => {
  test('chunked runs on one anchor write exactly the rows a single pass writes', async () => {
    const rollup = Container.get(RollupPortfolioValueDailyUseCase);
    const runStart = new Date();

    const single = await rollup.execute({
      userId: fixture.userId,
      lookbackDays: LOOKBACK,
      runStart,
    });
    expect(single.daysComputed).toBe(LOOKBACK);
    const oneShot = await readRows(fixture.userId);

    await db
      .delete(schema.portfolioValueDaily)
      .where(eq(schema.portfolioValueDaily.userId, fixture.userId));

    // An uneven step, so the last chunk is short and the boundaries fall
    // mid-way through the fixture's trades.
    const step = 30;
    let chunkedDays = 0;
    for (let from = 0; from < LOOKBACK; from += step) {
      const summary = await rollup.execute({
        userId: fixture.userId,
        lookbackDays: LOOKBACK,
        runStart,
        dayOffsets: { from, to: Math.min(LOOKBACK, from + step) },
      });
      chunkedDays += summary.daysComputed;
    }
    const chunked = await readRows(fixture.userId);

    // Each day computed once — not the whole window once per chunk.
    expect(chunkedDays).toBe(LOOKBACK);
    // user + institution + account + 2 holdings, per day.
    expect(oneShot).toHaveLength(LOOKBACK * 5);
    // The fixture must actually move, or equality proves nothing.
    expect(new Set(oneShot.map((r) => r.totalValue)).size).toBeGreaterThan(10);
    expect(chunked).toEqual(oneShot);
  });

  test('a chunk writes only its own days', async () => {
    await db
      .delete(schema.portfolioValueDaily)
      .where(eq(schema.portfolioValueDaily.userId, fixture.userId));
    const runStart = new Date('2026-09-21T12:00:00Z');
    await Container.get(RollupPortfolioValueDailyUseCase).execute({
      userId: fixture.userId,
      lookbackDays: LOOKBACK,
      runStart,
      dayOffsets: { from: 30, to: 60 },
    });
    const dates = [...new Set((await readRows(fixture.userId)).map((r) => r.snapshotDate))].sort();
    expect(dates).toHaveLength(30);
    expect(dates.at(-1)).toBe('2026-08-22'); // 30 days before the anchor
    expect(dates[0]).toBe('2026-07-24'); // 59 days before the anchor
  });

  // What exhausted the worker in prod was a chunk holding more history than it
  // needed (SC-1283). Since A5 PR-2 a chunk loads each holding's evidence once,
  // a bounded batch of holdings at a time, and never once per day (D-11).
  test('a 30-day chunk loads evidence once per batch of holdings, not once per day', async () => {
    await clearRows();
    // Spy on the instances this rollup holds, not on the prototypes: other test
    // files put their own repository in the container, and a singleton built
    // while one was there keeps it for the rest of the process.
    const useCase = Container.get(RollupPortfolioValueDailyUseCase);
    const balances = (useCase as unknown as { balanceAtTimeService: BalanceAtTimeService })
      .balanceAtTimeService;
    const evidence = (balances as unknown as { evidenceRepository: EngineEvidenceRepository })
      .evidenceRepository;
    const batches: number[] = [];
    const real = evidence.findHoldingEvidence.bind(evidence);
    spies.push(
      spyOn(evidence, 'findHoldingEvidence').mockImplementation((...args) => {
        batches.push(args[0].holdingIds?.length ?? Number.POSITIVE_INFINITY);
        return real(...args);
      })
    );
    const getBalance = spyOn(balances, 'getBalance');
    spies.push(getBalance);
    await useCase.execute({
      userId: fixture.userId,
      lookbackDays: LOOKBACK,
      runStart: new Date(),
      dayOffsets: { from: 0, to: 30 },
    });
    expect(batches.length).toBeGreaterThan(0);
    expect(Math.max(...batches)).toBeLessThanOrEqual(25);
    expect(batches.length).toBeLessThan(30);
    expect(getBalance).toHaveBeenCalled();
    for (const call of getBalance.mock.calls) {
      expect(call[3]?.balances?.get(call[0])?.get(call[1].getTime())).toBeDefined();
    }
  });
});
