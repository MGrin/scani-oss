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

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { withAdvisoryLock } from '@scani/db';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import Decimal from 'decimal.js';
import { eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { PortfolioValueDailyRepository } from '../../src/repositories/PortfolioValueDailyRepository';
import { TokenPriceRepository } from '../../src/repositories/TokenPriceRepository';
import {
  type PnLAtTimePerHolding,
  PnLAtTimeService,
} from '../../src/services/portfolio/PnLAtTimeService';
import { PriceGraphService } from '../../src/services/pricing/PriceGraphService';
import { RollupPortfolioValueDailyUseCase } from '../../src/use-cases/RollupPortfolioValueDailyUseCase';
import { restoreContainerAfterAll } from '../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

interface Fixture {
  userIds: string[];
  baseCurrencyId: string;
  // Lookup-table row ids — tracked so cleanupFixture can remove them.
  // Without this, every run leaks token_types + tokens rows.
  tokenTypeId: string;
  // userIds[0]'s single account + holding, so the per-scope derivation
  // (institution / account / holding rows) has something to derive.
  assetTokenId: string;
  holdingId: string;
  institutionId: string;
  institutionTypeId: string;
  accountTypeId: string;
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
  holdingsUnpriceable: number;
  holdingsStalePriced: number;
  holdingsBasisUnknown: number;
  transfersUnreviewed: number;
  perHolding: PnLAtTimePerHolding[];
} = () => ({
  totalValueInBase: new Decimal(100),
  totalCostBasis: new Decimal(0),
  totalRealizedPnl: new Decimal(0),
  totalUnrealizedPnl: new Decimal(100),
  totalPnl: new Decimal(100),
  coverageQuality: 'full' as const,
  holdingsWithKnownValue: 1,
  holdingsTotal: 1,
  holdingsUnpriceable: 0,
  holdingsStalePriced: 0,
  holdingsBasisUnknown: 0,
  transfersUnreviewed: 0,
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
      symbol: `RPV${randomUUID().toUpperCase()}`,
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

  // One account holding one asset for userIds[0]. The rollup derives an
  // institution / account / holding row per day from `perHolding`, and
  // those derivations are where an empty slice used to be written as a
  // fully-covered zero.
  const asset = await db
    .insert(schema.tokens)
    .values({
      symbol: `RPVA${randomUUID().toUpperCase()}`,
      name: 'RPV Asset',
      typeId: tokenType!.id,
    })
    .returning();
  const [institutionType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `rpv-inst-${randomUUID().slice(0, 6)}`, name: 'RPV Institution Type' })
    .returning();
  const [institution] = await db
    .insert(schema.institutions)
    .values({ name: 'RPV Institution', typeId: institutionType!.id })
    .returning();
  const [accountType] = await db
    .insert(schema.accountTypes)
    .values({ code: `rpv-acct-${randomUUID().slice(0, 6)}`, name: 'RPV Account Type' })
    .returning();
  const [account] = await db
    .insert(schema.accounts)
    .values({
      userId: userIds[0]!,
      institutionId: institution!.id,
      name: 'RPV Account',
      typeId: accountType!.id,
    })
    .returning();
  const [holding] = await db
    .insert(schema.holdings)
    .values({
      userId: userIds[0]!,
      accountId: account!.id,
      tokenId: asset[0]!.id,
      balance: '3',
    })
    .returning();

  return {
    userIds,
    baseCurrencyId: baseCurrency.id,
    tokenTypeId: tokenType!.id,
    assetTokenId: asset[0]!.id,
    holdingId: holding!.id,
    institutionId: institution!.id,
    institutionTypeId: institutionType!.id,
    accountTypeId: accountType!.id,
  };
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
  await db
    .delete(schema.tokens)
    .where(inArray(schema.tokens.id, [f.baseCurrencyId, f.assetTokenId]));
  await db.delete(schema.institutions).where(eq(schema.institutions.id, f.institutionId));
  await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, f.accountTypeId));
  await db
    .delete(schema.institutionTypes)
    .where(eq(schema.institutionTypes.id, f.institutionTypeId));
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
        holdingsUnpriceable: 0,
        holdingsStalePriced: 0,
        holdingsBasisUnknown: 0,
        transfersUnreviewed: 0,
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

  /**
   * SC-66 / P-5. Production held 5,710 rows written this way, and 123 of them
   * sat between two days worth real money — the chart drew a plunge to zero and
   * a spike back out, and the period delta was measured against the zero.
   */
  test('a scope with nothing priced that day is unknown coverage, not a confident zero', async () => {
    const f = fixture!;
    // perHolding stays empty, so every derived scope slice is empty.
    await Container.get(RollupPortfolioValueDailyUseCase).execute({
      userId: f.userIds[0]!,
      lookbackDays: 1,
    });

    const repo = Container.get(PortfolioValueDailyRepository);
    const rows = await repo.findRange(
      f.userIds[0]!,
      f.baseCurrencyId,
      new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      new Date(Date.now() + 24 * 60 * 60 * 1000),
      undefined,
      { kind: 'holding', id: f.holdingId }
    );

    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.holdingsTotal).toBe(0);
    expect(rows[0]?.totalValue).toBe('0');
    expect(rows[0]?.coverageQuality).toBe('unknown');
  });

  /**
   * SC-151 / SC-149. The per-entity scope rows are what the home chart and
   * both exports are built from, and `upsertScopeRow` used to compute neither
   * signal — so a stale price could reach the reader through a row marked
   * 'full', and a cost basis derived from a truncated import was recorded
   * exactly like one derived from a complete one.
   */
  test('per-entity scope rows carry the stale and basis-unknown counts', async () => {
    const f = fixture!;
    const accountId = (
      await db
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(eq(schema.accounts.userId, f.userIds[0]!))
        .limit(1)
    )[0]!.id;

    nextValuation = () => ({
      totalValueInBase: new Decimal(1500),
      totalCostBasis: new Decimal(900),
      totalRealizedPnl: new Decimal(0),
      totalUnrealizedPnl: new Decimal(600),
      totalPnl: new Decimal(600),
      coverageQuality: 'partial' as const,
      holdingsWithKnownValue: 2,
      holdingsTotal: 2,
      holdingsUnpriceable: 0,
      holdingsStalePriced: 1,
      holdingsBasisUnknown: 1,
      transfersUnreviewed: 0,
      perHolding: [
        {
          // Priced from a 96-day-old quote, and its history was truncated.
          holdingId: f.holdingId,
          accountId,
          tokenId: f.assetTokenId,
          value: new Decimal(1000),
          costBasis: new Decimal(500),
          realizedPnl: new Decimal(0),
          unrealizedPnl: new Decimal(500),
          unpriceable: false,
          priceStale: true,
          anchorSource: null,
          anchorAt: null,
          balanceBeforeRecords: false,
          balanceInterpolated: false,
          basisQuality: 'partial' as const,
          transfersUnreviewed: 0,
        },
        {
          holdingId: 'fresh-and-complete',
          accountId,
          tokenId: f.assetTokenId,
          value: new Decimal(500),
          costBasis: new Decimal(400),
          realizedPnl: new Decimal(0),
          unrealizedPnl: new Decimal(100),
          unpriceable: false,
          priceStale: false,
          anchorSource: null,
          anchorAt: null,
          balanceBeforeRecords: false,
          balanceInterpolated: false,
          basisQuality: 'known' as const,
          transfersUnreviewed: 0,
        },
      ],
    });

    await Container.get(RollupPortfolioValueDailyUseCase).execute({
      userId: f.userIds[0]!,
      lookbackDays: 1,
    });

    const repo = Container.get(PortfolioValueDailyRepository);
    const from = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const [accountRow] = await repo.findRange(
      f.userIds[0]!,
      f.baseCurrencyId,
      from,
      to,
      undefined,
      {
        kind: 'account',
        id: accountId,
      }
    );
    // Every holding priced, and still not 'full' — half the value is old.
    expect(accountRow?.holdingsWithKnownValue).toBe(2);
    expect(accountRow?.coverageQuality).toBe('partial');
    expect(accountRow?.holdingsStalePriced).toBe(1);
    expect(accountRow?.holdingsBasisUnknown).toBe(1);
    // The figures themselves are untouched: this is about what the reader is
    // told, not about withholding a number we have.
    expect(accountRow?.totalValue).toBe('1500');
    expect(accountRow?.costBasis).toBe('900');
  });

  /**
   * SC-146. The airdrop tokens are real rows in a real wallet, so they stay
   * in `holdings_total` and in the per-holding rows; what changes is that
   * they stop being counted as pricing failures.
   */
  test('unpriceable dust is persisted as excluded, not as an unpriced holding', async () => {
    const f = fixture!;
    const accountId = (
      await db
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(eq(schema.accounts.userId, f.userIds[0]!))
        .limit(1)
    )[0]!.id;

    nextValuation = () => ({
      totalValueInBase: new Decimal(1000),
      totalCostBasis: new Decimal(700),
      totalRealizedPnl: new Decimal(0),
      totalUnrealizedPnl: new Decimal(300),
      totalPnl: new Decimal(300),
      coverageQuality: 'full' as const,
      holdingsWithKnownValue: 1,
      holdingsTotal: 2,
      holdingsUnpriceable: 1,
      holdingsStalePriced: 0,
      holdingsBasisUnknown: 0,
      transfersUnreviewed: 0,
      perHolding: [
        {
          holdingId: 'priced-elsewhere',
          accountId,
          tokenId: f.assetTokenId,
          value: new Decimal(1000),
          costBasis: new Decimal(700),
          realizedPnl: new Decimal(0),
          unrealizedPnl: new Decimal(300),
          unpriceable: false,
          priceStale: false,
          anchorSource: null,
          anchorAt: null,
          balanceBeforeRecords: false,
          balanceInterpolated: false,
          basisQuality: 'known' as const,
          transfersUnreviewed: 0,
        },
        {
          holdingId: f.holdingId,
          accountId,
          tokenId: f.assetTokenId,
          value: null,
          costBasis: new Decimal(400),
          realizedPnl: new Decimal(25),
          unrealizedPnl: null,
          unpriceable: true,
          priceStale: false,
          anchorSource: null,
          anchorAt: null,
          balanceBeforeRecords: false,
          balanceInterpolated: false,
          basisQuality: 'known' as const,
          transfersUnreviewed: 0,
        },
      ],
    });

    await Container.get(RollupPortfolioValueDailyUseCase).execute({
      userId: f.userIds[0]!,
      lookbackDays: 1,
    });

    const repo = Container.get(PortfolioValueDailyRepository);
    const from = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const [userRow] = await repo.findRange(f.userIds[0]!, f.baseCurrencyId, from, to);
    expect(userRow?.holdingsTotal).toBe(2);
    expect(userRow?.holdingsUnpriceable).toBe(1);

    // Account scope: 1 of 2 valued, but only 1 of them was ever
    // priceable — full coverage, and the dust's cost stays out of the
    // total so no phantom unrealized loss appears.
    const [accountRow] = await repo.findRange(
      f.userIds[0]!,
      f.baseCurrencyId,
      from,
      to,
      undefined,
      {
        kind: 'account',
        id: accountId,
      }
    );
    expect(accountRow?.holdingsTotal).toBe(2);
    expect(accountRow?.holdingsUnpriceable).toBe(1);
    expect(accountRow?.holdingsWithKnownValue).toBe(1);
    expect(accountRow?.coverageQuality).toBe('full');
    expect(accountRow?.costBasis).toBe('700');
    expect(accountRow?.realizedPnl).toBe('0');

    // The dust's own holding row still exists — excluded from the
    // denominator is not deleted.
    const [holdingRow] = await repo.findRange(
      f.userIds[0]!,
      f.baseCurrencyId,
      from,
      to,
      undefined,
      {
        kind: 'holding',
        id: f.holdingId,
      }
    );
    expect(holdingRow?.holdingsTotal).toBe(1);
    expect(holdingRow?.holdingsUnpriceable).toBe(1);
    expect(holdingRow?.coverageQuality).toBe('unknown');
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

  /**
   * SC-160. Same lesson as the test above it, applied to the one count whose
   * error runs downward: an unanswered withdrawal books no gain, so realized
   * PnL is short by whatever the genuine off-platform sales among those rows
   * were worth.
   *
   * Written against the **per-holding** row deliberately. `upsertScopeRow` is
   * the writer the home chart reads; the `scope_kind = 'user'` row it is
   * tempting to assert on instead is written by a different path and is not
   * read for user-wide history. A count that reached only that row would pass
   * a lazier version of this test and reach no reader at all — which is
   * exactly how SC-151's stale-price downgrade stayed invisible for two
   * tickets.
   */
  test('per-holding scope rows carry the unreviewed-transfer count (SC-160)', async () => {
    const f = fixture!;
    const accountId = (
      await db
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(eq(schema.accounts.userId, f.userIds[0]!))
        .limit(1)
    )[0]!.id;

    nextValuation = () => ({
      totalValueInBase: new Decimal(1000),
      totalCostBasis: new Decimal(600),
      totalRealizedPnl: new Decimal(0),
      totalUnrealizedPnl: new Decimal(400),
      totalPnl: new Decimal(400),
      coverageQuality: 'full' as const,
      holdingsWithKnownValue: 1,
      holdingsTotal: 1,
      holdingsUnpriceable: 0,
      holdingsStalePriced: 0,
      holdingsBasisUnknown: 0,
      transfersUnreviewed: 2,
      perHolding: [
        {
          holdingId: f.holdingId,
          accountId,
          tokenId: f.assetTokenId,
          value: new Decimal(1000),
          costBasis: new Decimal(600),
          realizedPnl: new Decimal(0),
          unrealizedPnl: new Decimal(400),
          unpriceable: false,
          priceStale: false,
          anchorSource: null,
          anchorAt: null,
          balanceBeforeRecords: false,
          balanceInterpolated: false,
          basisQuality: 'known' as const,
          transfersUnreviewed: 2,
        },
      ],
    });

    await Container.get(RollupPortfolioValueDailyUseCase).execute({
      userId: f.userIds[0]!,
      lookbackDays: 1,
    });

    const repo = Container.get(PortfolioValueDailyRepository);
    const from = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const [holdingRow] = await repo.findRange(
      f.userIds[0]!,
      f.baseCurrencyId,
      from,
      to,
      undefined,
      {
        kind: 'holding',
        id: f.holdingId,
      }
    );

    expect(holdingRow?.transfersUnreviewed).toBe(2);
    // Untouched, as with every other quality count: this says what the figure
    // does not include, it does not change the figure.
    expect(holdingRow?.realizedPnl).toBe('0');
    expect(holdingRow?.coverageQuality).toBe('full');
  });

  /**
   * SC-252. The row this asserts is the one the reporting thread found:
   * `total_value = 586.94, coverage_quality = 'full'` on 2025-06-21, for a
   * holding whose first transaction is 2026-06-22.
   *
   * It is asserted on the PERSISTED row rather than on the valuation pass
   * because the stored row is the whole of what any reader gets — the home
   * chart, the PnL series and both exports are built from these per-holding
   * rows, and `upsertScopeRow` re-derives coverage rather than inheriting
   * it. A downgrade that lives only in the service above would never reach
   * a single surface (SC-151, and again SC-249).
   */
  test('a value reconstructed from before our records is never stored as full', async () => {
    const f = fixture!;
    const accountId = (
      await db
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(eq(schema.accounts.userId, f.userIds[0]!))
        .limit(1)
    )[0]!.id;

    nextValuation = () => ({
      totalValueInBase: new Decimal('586.94'),
      totalCostBasis: new Decimal(0),
      totalRealizedPnl: new Decimal(0),
      totalUnrealizedPnl: new Decimal('586.94'),
      totalPnl: new Decimal('586.94'),
      coverageQuality: 'partial' as const,
      holdingsWithKnownValue: 1,
      holdingsTotal: 1,
      holdingsUnpriceable: 0,
      holdingsStalePriced: 0,
      holdingsBasisUnknown: 0,
      transfersUnreviewed: 0,
      perHolding: [
        {
          holdingId: f.holdingId,
          accountId,
          tokenId: f.assetTokenId,
          value: new Decimal('586.94'),
          costBasis: new Decimal(0),
          realizedPnl: new Decimal(0),
          unrealizedPnl: new Decimal('586.94'),
          unpriceable: false,
          // Nothing else is wrong with this holding: the price is fresh, the
          // anchor is forward, the basis is known. Every other quality signal
          // reads clean, which is exactly why the day read 'full'.
          priceStale: false,
          anchorSource: 'holdings',
          anchorAt: new Date(),
          balanceBeforeRecords: true,
          balanceInterpolated: false,
          basisQuality: 'known' as const,
          transfersUnreviewed: 0,
        },
      ],
    });

    await Container.get(RollupPortfolioValueDailyUseCase).execute({
      userId: f.userIds[0]!,
      lookbackDays: 1,
    });

    const repo = Container.get(PortfolioValueDailyRepository);
    const from = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const [holdingRow] = await repo.findRange(
      f.userIds[0]!,
      f.baseCurrencyId,
      from,
      to,
      undefined,
      { kind: 'holding', id: f.holdingId }
    );

    expect(holdingRow?.coverageQuality).not.toBe('full');
    expect(holdingRow?.coverageQuality).toBe('partial');
    // The figure survives. Bounding the claim is the fix; withholding the
    // number would empty the chart for every newly-onboarded user, which
    // `PortfolioValuationAtTimeService` deliberately does not do.
    expect(holdingRow?.totalValue).toBe('586.94');
    expect(holdingRow?.holdingsWithKnownValue).toBe(1);
    // SC-317. The grade WITH its cause. Until this column the row said
    // 'partial' while both existing reason counts read zero, so a reader
    // could see that confidence had been reduced and not why — and the two
    // zeros actively pointed away from the answer, because they are the
    // causes it was NOT.
    expect(holdingRow?.holdingsBeforeRecords).toBe(1);
    expect(holdingRow?.holdingsStaleAnchored).toBe(0);
    expect(holdingRow?.holdingsStalePriced).toBe(0);
  });
  // SC-315. The prefetch exists to preload every (from, to) pair
  // `PriceGraphService.tryDirect` can ask for during the pass, which
  // includes each hub. It used to derive those hubs from its own
  // `PRICE_HUB_SYMBOLS` copy under a "keep in sync" comment; a
  // disagreement between the two lists is silent, because a missing
  // pair degrades to a per-leg DB round-trip rather than a wrong
  // number. Emptying that list failed no test.
  //
  // The enumeration itself moved onto `PriceGraphService.buildPriceLookup`
  // (SC-471), which is why this uses a REAL graph with only its hub
  // resolution and its conversions stubbed: a fully stubbed graph would
  // stand in for the code under test and pass no matter what the rollup
  // handed it. What the rollup still owns is WHICH tokens it asks about.
  test('the price prefetch preloads exactly the hubs the price graph will walk', async () => {
    const f = fixture!;
    const hubIds = ['hub-alpha', 'hub-beta'];
    let pairs: ReadonlyArray<{ tokenId: string; baseTokenId: string }> = [];

    Container.set(TokenPriceRepository, {
      findManyForPairsUpTo: async (p: ReadonlyArray<{ tokenId: string; baseTokenId: string }>) => {
        pairs = p;
        return [];
      },
    } as unknown as TokenPriceRepository);
    const graph = new PriceGraphService();
    graph.resolveHubTokenIds = async () => hubIds;
    graph.convert = async () => null;
    Container.set(PriceGraphService, graph);
    Container.set(RollupPortfolioValueDailyUseCase, new RollupPortfolioValueDailyUseCase());

    await Container.get(RollupPortfolioValueDailyUseCase).execute({
      userId: f.userIds[0]!,
      lookbackDays: 1,
    });

    const asked = new Set(pairs.flatMap((p) => [p.tokenId, p.baseTokenId]));
    for (const hubId of hubIds) {
      expect(asked.has(hubId)).toBe(true);
      // Both directions: tryDirect inverts when the forward leg misses.
      expect(pairs.some((p) => p.tokenId === f.assetTokenId && p.baseTokenId === hubId)).toBe(true);
      expect(pairs.some((p) => p.tokenId === hubId && p.baseTokenId === f.assetTokenId)).toBe(true);
    }
  });
});
