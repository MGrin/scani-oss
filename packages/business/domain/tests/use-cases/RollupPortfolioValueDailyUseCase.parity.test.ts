/**
 * The row the rollup stores for a day must be what `getPnL` answers for that
 * instant when nobody hands it anything (SC-1551).
 *
 * Unstubbed on purpose: both defects sit between a preload and the read it
 * stands in for, and a stub on either side is the seam.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { PnLAtTimeService } from '../../src/services/portfolio/PnLAtTimeService';
import { RollupPortfolioValueDailyUseCase } from '../../src/use-cases/RollupPortfolioValueDailyUseCase';
import { seedHoldingCache } from '../../test/helpers/engine-guard';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const RUN_START = new Date('2026-10-04T12:00:00.000Z');
const DAY0 = Date.UTC(2026, 9, 4);
const ago = (days: number, hour = 0) => new Date(DAY0 - days * DAY + hour * HOUR);

/** The instants the rollup values, newest first. */
function windowDays(lookback: number) {
  return Array.from({ length: lookback }, (_, i) => {
    const at = new Date(RUN_START.getTime() - i * DAY);
    if (i > 0) at.setUTCHours(23, 59, 59, 999);
    return { at, snapshotDate: at.toISOString().slice(0, 10) };
  });
}

interface Spec {
  /** Units the holding holds now. */
  balance: string;
  /** Daily prices for this many days back, at `price`. */
  pricedDays: number;
  price: string;
  trades: Array<{ kind: string; quantity: string; at: Date }>;
  readings: Array<{ balance: string; at: Date }>;
  lastUpdated: Date;
}

interface Fixture {
  userId: string;
  usdId: string;
  holdingId: string;
  tokenId: string;
  tokenTypeId: string;
  institutionId: string;
  institutionTypeId: string;
  accountTypeId: string;
}

const fixtures: Fixture[] = [];

async function setupFixture(spec: Spec): Promise<Fixture> {
  const [usd] = await db
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .where(eq(schema.tokens.symbol, 'USD'))
    .limit(1);
  if (!usd) throw new Error('USD token not seeded');
  const tag = randomUUID().slice(0, 6);
  const [tokenType] = await db
    .insert(schema.tokenTypes)
    .values({ code: `rpvp-${tag}`, name: 'RPVP Token Type' })
    .returning();
  const [user] = await db
    .insert(schema.users)
    .values({
      email: `rpvp-${randomUUID().slice(0, 8)}@scani.local`,
      name: 'RPVP User',
      baseCurrencyId: usd.id,
    })
    .returning();
  const [institutionType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `rpvp-inst-${tag}`, name: 'RPVP Institution Type' })
    .returning();
  const [institution] = await db
    .insert(schema.institutions)
    .values({ name: 'RPVP Institution', typeId: institutionType!.id })
    .returning();
  const [accountType] = await db
    .insert(schema.accountTypes)
    .values({ code: `rpvp-acct-${tag}`, name: 'RPVP Account Type' })
    .returning();
  const [account] = await db
    .insert(schema.accounts)
    .values({
      userId: user!.id,
      institutionId: institution!.id,
      name: 'RPVP Account',
      typeId: accountType!.id,
    })
    .returning();
  const [token] = await db
    .insert(schema.tokens)
    .values({
      symbol: `RPVP${randomUUID().toUpperCase()}`,
      name: 'RPVP token',
      typeId: tokenType!.id,
    })
    .returning();
  await db.insert(schema.tokenPrices).values(
    Array.from({ length: spec.pricedDays }, (_, i) => ({
      tokenId: token!.id,
      baseTokenId: usd.id,
      price: spec.price,
      timestamp: ago(i),
      granularity: 'daily' as const,
      source: 'rpvp-test',
    }))
  );
  const [holding] = await seedHoldingCache(db, (calculator) =>
    calculator
      .insert(schema.holdings)
      .values({
        userId: user!.id,
        accountId: account!.id,
        tokenId: token!.id,
        balance: spec.balance,
        isHidden: false,
        isActive: true,
        createdAt: ago(300),
        lastUpdated: spec.lastUpdated,
      })
      .returning()
  );
  if (spec.trades.length > 0) {
    await db.insert(schema.holdingTransactions).values(
      spec.trades.map((t, k) => ({
        userId: user!.id,
        holdingId: holding!.id,
        tokenId: token!.id,
        kind: t.kind,
        quantity: t.quantity,
        occurredAt: t.at,
        externalId: `rpvp-${k}`,
        source: 'rpvp-test',
      }))
    );
  }
  await db.insert(schema.holdingBalanceObservations).values(
    spec.readings.map((r) => ({
      userId: user!.id,
      holdingId: holding!.id,
      balance: r.balance,
      observedAt: r.at,
      source: 'sync-capture',
    }))
  );
  const fixture: Fixture = {
    userId: user!.id,
    usdId: usd.id,
    holdingId: holding!.id,
    tokenId: token!.id,
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
    await db.delete(schema.tokenPrices).where(inArray(schema.tokenPrices.tokenId, [f.tokenId]));
    await db.delete(schema.tokens).where(eq(schema.tokens.id, f.tokenId));
    await db.delete(schema.institutions).where(eq(schema.institutions.id, f.institutionId));
    await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, f.accountTypeId));
    await db
      .delete(schema.institutionTypes)
      .where(eq(schema.institutionTypes.id, f.institutionTypeId));
    await db.delete(schema.tokenTypes).where(eq(schema.tokenTypes.id, f.tokenTypeId));
  }
});

/** Stored user-scope figures beside `getPnL` asked afresh, one entry per day. */
async function storedAndAdHoc(f: Fixture, lookback: number) {
  await Container.get(RollupPortfolioValueDailyUseCase).execute({
    userId: f.userId,
    lookbackDays: lookback,
    runStart: RUN_START,
  });
  const rows = await db
    .select()
    .from(schema.portfolioValueDaily)
    .where(
      and(
        eq(schema.portfolioValueDaily.userId, f.userId),
        eq(schema.portfolioValueDaily.scopeKind, 'user')
      )
    );
  const byDate = new Map(rows.map((r) => [String(r.snapshotDate).slice(0, 10), r]));
  const pnl = Container.get(PnLAtTimeService);
  const stored = [];
  const adHoc = [];
  for (const { at, snapshotDate } of windowDays(lookback)) {
    const r = byDate.get(snapshotDate);
    stored.push({ snapshotDate, totalValue: r?.totalValue, costBasis: r?.costBasis });
    const a = await pnl.getPnL(f.userId, at, f.usdId, { tx: undefined });
    adHoc.push({
      snapshotDate,
      totalValue: a.totalValueInBase.toString(),
      costBasis: a.totalCostBasis.toString(),
    });
  }
  return { stored, adHoc };
}

describe('RollupPortfolioValueDailyUseCase — stored rows match getPnL', () => {
  test('a negative reading between anchors floors the balance as it does ad hoc (SC-1551)', async () => {
    // Readings +100 (first), -500, +50, 0; ledger -200 then +150. At the end
    // of 09-30 the walk back from the 0 on 10-04 gives -150. The anchors the
    // rollup preloads are {+100, +50, 0}, so it floored at 0. The window is
    // 8 days because each ad hoc day is a full getPnL; 30 timed out in CI.
    const f = await setupFixture({
      balance: '0',
      pricedDays: 40,
      price: '1',
      trades: [
        { kind: 'withdraw', quantity: '-200', at: ago(14, 10) },
        { kind: 'deposit', quantity: '150', at: ago(2, 10) },
      ],
      readings: [
        { balance: '100', at: ago(262, 8) },
        { balance: '-500', at: ago(203, 8) },
        { balance: '50', at: ago(31, 8) },
        { balance: '0', at: ago(0, 8) },
      ],
      lastUpdated: ago(0, 8),
    });
    const { stored, adHoc } = await storedAndAdHoc(f, 8);
    const day = adHoc.find((d) => d.snapshotDate === '2026-09-30');
    expect(day?.totalValue).toBe('-150');
    expect(stored.map((d) => d.totalValue)).toEqual(adHoc.map((d) => d.totalValue));
  });
});
