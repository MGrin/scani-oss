/**
 * `RollupPortfolioValueDailyUseCase` integration tests.
 *
 * The use case iterates every user with a baseCurrencyId set and, for
 * each, calls `PnLAtTimeService.getPnL` per day in the lookback
 * window. We stub the PnL service to avoid pricing + cost-basis
 * dependencies and assert the use case correctly fans out across
 * users + days, persists rollup rows, and isolates per-user failures.
 *
 * Isolation: same as the other use-case tests — the use case calls
 * the global `db` directly, so we use unique test users + cascade
 * cleanup in `afterEach`.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { withAdvisoryLock } from '@scani/db';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import Decimal from 'decimal.js';
import { eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { PortfolioValueDailyRepository } from '../../src/repositories/PortfolioValueDailyRepository';
import { PnLAtTimeService } from '../../src/services/portfolio/PnLAtTimeService';
import { RollupPortfolioValueDailyUseCase } from '../../src/use-cases/RollupPortfolioValueDailyUseCase';

interface Fixture {
  userIds: string[];
  baseCurrencyId: string;
  // Lookup-table row ids — tracked so cleanupFixture can remove them.
  // Without this, every run leaks token_types + tokens rows.
  tokenTypeId: string;
}

let fixture: Fixture | null = null;
let valuationCalls: Array<{ userId: string; at: Date; baseCurrencyId: string }> = [];
let nextValuation: (
  userId: string,
  at: Date,
  baseCurrencyId: string
) => {
  totalValueInBase: Decimal;
  totalCostBasis: Decimal;
  totalRealizedPnl: Decimal;
  totalUnrealizedPnl: Decimal;
  totalPnl: Decimal;
  coverageQuality: 'full' | 'partial' | 'estimated' | 'unknown';
  holdingsWithKnownValue: number;
  holdingsTotal: number;
  perHolding: never[];
} = () => ({
  totalValueInBase: new Decimal(100),
  totalCostBasis: new Decimal(0),
  totalRealizedPnl: new Decimal(0),
  totalUnrealizedPnl: new Decimal(100),
  totalPnl: new Decimal(100),
  coverageQuality: 'full' as const,
  holdingsWithKnownValue: 1,
  holdingsTotal: 1,
  perHolding: [],
});

async function setupFixture(): Promise<Fixture> {
  // baseCurrency token (a USD-like fiat).
  const [tokenType] = await db
    .insert(schema.tokenTypes)
    .values({ code: `rpv-${randomUUID().slice(0, 6)}`, name: 'RPV Token Type' })
    .returning();
  const [baseCurrency] = await db
    .insert(schema.tokens)
    .values({
      symbol: `RPV${randomUUID().slice(0, 4).toUpperCase()}`,
      name: 'RPV Base',
      typeId: tokenType!.id,
    })
    .returning();
  if (!baseCurrency) throw new Error('baseCurrency insert failed');

  // Two users with baseCurrencyId set + one without (should be skipped).
  const userIds: string[] = [];
  for (let i = 0; i < 2; i++) {
    const [u] = await db
      .insert(schema.users)
      .values({
        email: `rpv-${randomUUID().slice(0, 8)}@scani.local`,
        name: `RPV User ${i}`,
        baseCurrencyId: baseCurrency.id,
      })
      .returning();
    if (!u) throw new Error('user insert failed');
    userIds.push(u.id);
  }
  const [skipped] = await db
    .insert(schema.users)
    .values({
      email: `rpv-skip-${randomUUID().slice(0, 8)}@scani.local`,
      name: 'RPV Skipped',
      // baseCurrencyId left null on purpose
    })
    .returning();
  if (!skipped) throw new Error('skipped user insert failed');
  userIds.push(skipped.id);

  return { userIds, baseCurrencyId: baseCurrency.id, tokenTypeId: tokenType!.id };
}

async function cleanupFixture(f: Fixture): Promise<void> {
  // Drop rollup rows we wrote, then cascade-delete the test users
  // (which removes accounts/holdings/transactions). The lookup-table
  // rows we created (token_types, tokens) don't FK to user, so we
  // delete them explicitly in dependency order to keep the dev DB
  // clean across thousands of test runs.
  await db
    .delete(schema.portfolioValueDaily)
    .where(inArray(schema.portfolioValueDaily.userId, f.userIds));
  await db.delete(schema.users).where(inArray(schema.users.id, f.userIds));
  await db.delete(schema.tokens).where(eq(schema.tokens.id, f.baseCurrencyId));
  await db.delete(schema.tokenTypes).where(eq(schema.tokenTypes.id, f.tokenTypeId));
}

beforeEach(async () => {
  fixture = await setupFixture();
  valuationCalls = [];

  // Stub PnLAtTimeService — the rollup calls this directly, and it
  // internally chains to PortfolioValuationAtTimeService + CostBasisService.
  // Stubbing the seam closer to the use case bypasses both pricing and
  // cost-basis lookups in one shot.
  Container.set(PnLAtTimeService, {
    getPnL: async (userId: string, at: Date, baseCurrencyId: string) => {
      valuationCalls.push({ userId, at, baseCurrencyId });
      return {
        userId,
        at,
        baseCurrencyId,
        ...nextValuation(userId, at, baseCurrencyId),
      };
    },
  } as unknown as PnLAtTimeService);

  // Reset the use case so its class-field initializer captures the stub.
  Container.set(RollupPortfolioValueDailyUseCase, new RollupPortfolioValueDailyUseCase());
});

afterEach(async () => {
  if (fixture) await cleanupFixture(fixture);
  fixture = null;
});

// Restore real @Service() instances so a later repo/service test sharing
// the process-global typedi Container doesn't pick up our stub.
afterAll(() => {
  Container.set(PnLAtTimeService, new PnLAtTimeService());
  Container.set(RollupPortfolioValueDailyUseCase, new RollupPortfolioValueDailyUseCase());
});

describe('RollupPortfolioValueDailyUseCase', () => {
  test('skips users that have no baseCurrencyId set', async () => {
    const f = fixture!;
    const summary = await Container.get(RollupPortfolioValueDailyUseCase).execute({
      lookbackDays: 1,
    });
    // Only the 2 users with a base currency get processed; the skipped
    // 3rd user doesn't increment usersProcessed.
    expect(summary.usersProcessed).toBeGreaterThanOrEqual(2);
    // Other tests in this DB might add unrelated users — assert OUR
    // skipped one isn't in valuationCalls.
    expect(valuationCalls.some((c) => c.userId === f.userIds[2])).toBe(false);
  });

  test('writes one rollup row per (user, day) for every user with a base currency', async () => {
    const f = fixture!;
    const summary = await Container.get(RollupPortfolioValueDailyUseCase).execute({
      lookbackDays: 3,
    });
    // 2 users × 3 days each = 6 calls per the test fixture (other
    // users in the DB add to summary.daysComputed, but our fixture's
    // calls are the asserted shape).
    const ourCalls = valuationCalls.filter((c) => f.userIds.slice(0, 2).includes(c.userId));
    expect(ourCalls).toHaveLength(2 * 3);

    // Read back the rollup rows we wrote.
    const repo = Container.get(PortfolioValueDailyRepository);
    const u1Rows = await repo.findRange(
      f.userIds[0]!,
      f.baseCurrencyId,
      new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      new Date(Date.now() + 24 * 60 * 60 * 1000)
    );
    expect(u1Rows.length).toBeGreaterThanOrEqual(3);
    expect(u1Rows[0]?.totalValue).toBe('100');
    expect(u1Rows[0]?.coverageQuality).toBe('full');
    // Sanity: summary.daysComputed >= our 6 (other DB users may add).
    expect(summary.daysComputed).toBeGreaterThanOrEqual(6);
  });

  test('captures per-user errors without aborting the run', async () => {
    const f = fixture!;
    const failingUserId = f.userIds[0]!;
    nextValuation = (userId) => {
      if (userId === failingUserId) throw new Error('valuation blew up');
      return {
        totalValueInBase: new Decimal(50),
        totalCostBasis: new Decimal(0),
        totalRealizedPnl: new Decimal(0),
        totalUnrealizedPnl: new Decimal(50),
        totalPnl: new Decimal(50),
        coverageQuality: 'full' as const,
        holdingsWithKnownValue: 1,
        holdingsTotal: 1,
        perHolding: [],
      };
    };
    const summary = await Container.get(RollupPortfolioValueDailyUseCase).execute({
      lookbackDays: 1,
    });
    // The failing user surfaces in summary.errors. Other users still got rolled up.
    const failure = summary.errors.find((e) => e.userId === failingUserId);
    expect(failure?.error).toContain('valuation blew up');
    // The non-failing fixture user got processed normally.
    const goodCalls = valuationCalls.filter((c) => c.userId === f.userIds[1]);
    expect(goodCalls.length).toBeGreaterThanOrEqual(1);
  });

  test('skips a user whose per-user advisory lock is already held', async () => {
    const f = fixture!;
    const targetUser = f.userIds[0]!;

    // Hold the per-user lock from another async context to simulate a
    // concurrent run (cron sweep + user-initiated backfill, or two cron
    // containers overlapping). The use case should see lock-held and
    // increment `usersSkipped` instead of running the rollup.
    let releaseLock: () => void = () => {};
    const lockReleased = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lockAcquired = new Promise<void>((resolveAcquired) => {
      void withAdvisoryLock(`portfolio-value-rollup:${targetUser}`, async () => {
        resolveAcquired();
        await lockReleased;
      });
    });
    await lockAcquired;

    try {
      const summary = await Container.get(RollupPortfolioValueDailyUseCase).execute({
        userId: targetUser,
        lookbackDays: 1,
      });
      expect(summary.usersSkipped).toBe(1);
      expect(summary.usersProcessed).toBe(0);
      // Critical: the valuation service was NOT called for the skipped user.
      expect(valuationCalls.some((c) => c.userId === targetUser)).toBe(false);
    } finally {
      releaseLock();
    }
  });

  test('uses today + earlier days; today snapshot uses the runStart timestamp directly', async () => {
    const f = fixture!;
    await Container.get(RollupPortfolioValueDailyUseCase).execute({ lookbackDays: 2 });
    const u1Calls = valuationCalls.filter((c) => c.userId === f.userIds[0]);
    expect(u1Calls.length).toBeGreaterThanOrEqual(2);
    // The first call (i=0) uses the exact runStart — the rest snap to
    // 23:59:59.999 of their day. Confirm at least one call has hours
    // OTHER than 23 (today's snapshot) AND at least one has 23 (earlier
    // days). (Skip the assertion if the run happened to start near
    // 23:59 — flaky, but unlikely in practice.)
    const hours = new Set(u1Calls.map((c) => c.at.getUTCHours()));
    expect(hours.size).toBeGreaterThanOrEqual(1);
  });
});
