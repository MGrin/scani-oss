/**
 * SC-1590: a hand-valued fund modelled as units of a custom token, priced by
 * hand at each monthly observation (NAV per unit). Deposits buy units at the
 * NAV of the day; a withdrawal sells them. Real database, nothing stubbed.
 *
 * The NAV series steps 10 → 11 → 12.1 → 13.31, one step every 30 days, so the
 * time-weighted return between the first and last NAV is exactly 33.1% —
 * whatever the flows were, because both flows happen at the NAV of the day.
 *
 * The last NAV is 30 days old "now": outside the 7-day cap the current day
 * applies to a provider's price, and still not stale, because a price a
 * person typed stands until the next one (D-2).
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '@scani/db';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import type Decimal from 'decimal.js';
import { and, eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingCoverageRepository } from '../../../src/repositories/HoldingCoverageRepository';
import { OpeningBalanceReconciliationService } from '../../../src/services/holdings/OpeningBalanceReconciliationService';
import { PnLAtTimeService } from '../../../src/services/portfolio/PnLAtTimeService';
import { PriceWriter } from '../../../src/services/pricing/PriceWriter';
import { ReturnsService } from '../../../src/services/returns/ReturnsService';
import { RollupPortfolioValueDailyUseCase } from '../../../src/use-cases/RollupPortfolioValueDailyUseCase';
import { withTestDb } from '../../../test/helpers/db';
import { seedHoldingCache } from '../../../test/helpers/engine-guard';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date();
const MIDDAY = Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate(), 12);
const day = (offset: number) => new Date(MIDDAY + offset * DAY_MS);

/** Day offsets from today. The last NAV is 30 days old. */
const T0 = -120;
const NAVS = [
  { at: T0, nav: '10' },
  { at: T0 + 30, nav: '11' },
  { at: T0 + 60, nav: '12.1' },
  { at: T0 + 90, nav: '13.31' },
];
const DEPOSIT = { at: T0, units: '100', nav: '10' };
const WITHDRAWAL = { at: T0 + 75, units: '20', nav: '12.1' };

interface Fixture {
  userId: string;
  usdId: string;
  accountId: string;
  institutionId: string;
  fundTokenId: string;
  fundHoldingId: string;
  cashHoldingId: string;
}

type Writer = typeof db | DatabaseTransaction;

async function seededId(
  table: typeof schema.tokenTypes | typeof schema.institutionTypes | typeof schema.accountTypes,
  code: string,
  w: Writer
) {
  const [row] = await w.select({ id: table.id }).from(table).where(eq(table.code, code));
  if (!row) throw new Error(`seeded ${code} row missing — is the database migrated?`);
  return row.id;
}

async function setupFixture(w: Writer): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const [usd] = await w
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .where(and(eq(schema.tokens.symbol, 'USD'), eq(schema.tokens.isActive, true)));
  if (!usd) throw new Error('seeded USD token missing');

  const [user] = await w
    .insert(schema.users)
    .values({ email: `fund-${suffix}@scani.local`, name: 'Fund Unit', baseCurrencyId: usd.id })
    .returning();
  const [institution] = await w
    .insert(schema.institutions)
    .values({ name: `Fund ${suffix}`, typeId: await seededId(schema.institutionTypes, 'other', w) })
    .returning();
  const accountTypeId = await seededId(schema.accountTypes, 'other', w);
  // The cash control sits in its own account so the fund account's return is
  // the fund's alone; together they blend to 21.52%, not 33.1%.
  const [account] = await w
    .insert(schema.accounts)
    .values({
      userId: user!.id,
      institutionId: institution!.id,
      name: 'Fund account',
      typeId: accountTypeId,
    })
    .returning();
  const [cashAccount] = await w
    .insert(schema.accounts)
    .values({
      userId: user!.id,
      institutionId: institution!.id,
      name: 'Cash account',
      typeId: accountTypeId,
    })
    .returning();
  const [fund] = await w
    .insert(schema.tokens)
    .values({
      symbol: `FU${suffix.toUpperCase()}`,
      name: 'Fund unit',
      typeId: await seededId(schema.tokenTypes, 'other', w),
      createdByUserId: user!.id,
      providerMetadata: { provider: 'manual' },
    })
    .returning();

  const holdingRows = await seedHoldingCache(w, (calculator) =>
    calculator
      .insert(schema.holdings)
      .values([
        { userId: user!.id, accountId: account!.id, tokenId: fund!.id, balance: '80' },
        { userId: user!.id, accountId: cashAccount!.id, tokenId: usd.id, balance: '500' },
      ])
      .returning()
  );
  // Keyed by token: SQL does not promise RETURNING's order.
  const fundHolding = holdingRows.find((h) => h.tokenId === fund!.id);
  const cashHolding = holdingRows.find((h) => h.tokenId === usd.id);

  await w.insert(schema.holdingTransactions).values([
    {
      userId: user!.id,
      holdingId: fundHolding!.id,
      tokenId: fund!.id,
      kind: 'deposit',
      quantity: DEPOSIT.units,
      priceNative: DEPOSIT.nav,
      priceNativeTokenId: usd.id,
      occurredAt: day(DEPOSIT.at),
      externalId: `fund-dep-${suffix}`,
      source: 'test',
    },
    {
      userId: user!.id,
      holdingId: fundHolding!.id,
      tokenId: fund!.id,
      kind: 'withdraw',
      quantity: `-${WITHDRAWAL.units}`,
      priceNative: WITHDRAWAL.nav,
      priceNativeTokenId: usd.id,
      occurredAt: day(WITHDRAWAL.at),
      transferReview: 'left_control',
      externalId: `fund-wd-${suffix}`,
      source: 'test',
    },
    // The control: USD cash in a USD-based portfolio. Its basis is its value.
    {
      userId: user!.id,
      holdingId: cashHolding!.id,
      tokenId: usd.id,
      kind: 'deposit',
      quantity: '500',
      occurredAt: day(T0),
      externalId: `fund-cash-${suffix}`,
      source: 'test',
    },
  ]);
  // The repository's own write does this; a raw insert has to, or the
  // holding reads as having no ledger at all.
  await Container.get(HoldingCoverageRepository).syncTxBoundsFromLedger(
    [fundHolding!.id, cashHolding!.id],
    'rollback' in w ? (w as DatabaseTransaction) : undefined
  );

  const writer = Container.get(PriceWriter);
  const writeNavs = async (tx: DatabaseTransaction) => {
    for (const { at, nav } of NAVS) {
      await writer.writeManual(
        {
          tokenId: fund!.id,
          baseTokenId: usd.id,
          price: nav,
          at: day(at),
          granularity: 'intraday',
          source: 'manual',
        },
        tx
      );
    }
  };
  if ('rollback' in w) await writeNavs(w as DatabaseTransaction);
  else await db.transaction(writeNavs);

  return {
    userId: user!.id,
    usdId: usd.id,
    accountId: account!.id,
    institutionId: institution!.id,
    fundTokenId: fund!.id,
    fundHoldingId: fundHolding!.id,
    cashHoldingId: cashHolding!.id,
  };
}

const money = (d: Decimal | null | undefined) => d?.toDecimalPlaces(2).toString() ?? null;

describe('SC-1590 fund units: PnL', () => {
  test('basis is net contributions, growth is unrealized, the withdrawal realizes its share', async () => {
    await withTestDb(async (tx) => {
      const f = await setupFixture(tx);
      const pnl = await Container.get(PnLAtTimeService).getPnL(f.userId, NOW, f.usdId, { tx });
      const fund = pnl.perHolding.find((h) => h.holdingId === f.fundHoldingId);
      const cash = pnl.perHolding.find((h) => h.holdingId === f.cashHoldingId);

      // 80 units × 13.31.
      expect(money(fund?.value)).toBe('1064.8');
      // 100 units bought for 1000; 20 of them left at their average cost.
      expect(money(fund?.costBasis)).toBe('800');
      // 20 × 12.1 − 200.
      expect(money(fund?.realizedPnl)).toBe('42');
      expect(money(fund?.unrealizedPnl)).toBe('264.8');

      // The control: USD cash in a USD portfolio stays at par.
      expect(money(cash?.value)).toBe('500');
      expect(money(cash?.unrealizedPnl)).toBe('0');
    });
  });

  test('a 30-day-old NAV is not stale, today or on a historical day', async () => {
    await withTestDb(async (tx) => {
      const f = await setupFixture(tx);
      const service = Container.get(PnLAtTimeService);
      const today = await service.getPnL(f.userId, NOW, f.usdId, { tx });
      const past = await service.getPnL(f.userId, day(T0 + 80), f.usdId, { tx });
      const fundOf = (r: typeof today) => r.perHolding.find((h) => h.holdingId === f.fundHoldingId);

      expect(fundOf(today)?.priceStale).toBe(false);
      expect(fundOf(past)?.priceStale).toBe(false);
      // The step holds between NAVs: 80 units × the 12.1 NAV of day T0+60.
      expect(money(fundOf(past)?.value)).toBe('968');
    });
  });
});

describe('SC-1590 fund units: Returns', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await setupFixture(db);
    await Container.get(OpeningBalanceReconciliationService).reconcileHolding(f.fundHoldingId);
    await Container.get(OpeningBalanceReconciliationService).reconcileHolding(f.cashHoldingId);
    await Container.get(RollupPortfolioValueDailyUseCase).execute({
      userId: f.userId,
      lookbackDays: -T0 + 2,
      runStart: NOW,
    });
  });

  afterAll(async () => {
    if (!f) return;
    await db
      .delete(schema.portfolioValueDaily)
      .where(eq(schema.portfolioValueDaily.userId, f.userId));
    await db.delete(schema.tokenPrices).where(eq(schema.tokenPrices.tokenId, f.fundTokenId));
    await db.delete(schema.users).where(eq(schema.users.id, f.userId));
    await db.delete(schema.tokens).where(eq(schema.tokens.id, f.fundTokenId));
    await db.delete(schema.institutions).where(eq(schema.institutions.id, f.institutionId));
  });

  const compute = (window: { from: Date; to: Date } | 'all') =>
    Container.get(ReturnsService).compute({
      userId: f.userId,
      scope: { kind: 'account', id: f.accountId },
      window: window === 'all' ? { kind: 'all' } : { kind: 'custom', ...window },
    });

  test('the account is eligible and its TWR is the NAV path, within 0.1 pp', async () => {
    const out = await compute({ from: day(T0), to: day(T0 + 90) });
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.returns.eligibility.reasons).toEqual([]);
    expect(out.returns.subset).toBeNull();
    const twr = Number(out.returns.twr?.cumulative);
    expect(Math.abs(twr - 0.331)).toBeLessThan(0.001);
  });

  test('a window reaching today admits it: the last NAV is not stale', async () => {
    const out = await compute('all');
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.returns.eligibility.reasons).toEqual([]);
    expect(out.returns.subset).toBeNull();
  });
});
