/**
 * SC-1477: a stored price in the user's base currency must not beat a newer
 * price in another base. Real database, nothing stubbed.
 *
 * A EUR-based user holds one unit of a token. Import warm-up wrote the token
 * in EUR once, 30 days ago, at 100. Since then the hourly run has priced it in
 * USD, at 200 an hour ago, beside a fresh EUR rate of 1.25 USD. Today the
 * unit is worth 200 / 1.25 = 160 EUR, and the 30-day-old 100 is the frozen
 * value the defect keeps showing.
 *
 * The dashboard already reads the freshest route (`priceAt`), so it is this
 * fixture's control. The chart's day row is the case under test.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import Decimal from 'decimal.js';
import { and, eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingCoverageRepository } from '../../../src/repositories/HoldingCoverageRepository';
import { OpeningBalanceReconciliationService } from '../../../src/services/holdings/OpeningBalanceReconciliationService';
import { PortfolioValuationService } from '../../../src/services/portfolio/PortfolioValuationService';
import { PriceWriter } from '../../../src/services/pricing/PriceWriter';
import { RollupPortfolioValueDailyUseCase } from '../../../src/use-cases/RollupPortfolioValueDailyUseCase';
import { seedHoldingCache } from '../../../test/helpers/engine-guard';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date();
const AN_HOUR_AGO = new Date(NOW.getTime() - 60 * 60 * 1000);
const FROZEN_AT = new Date(NOW.getTime() - 30 * DAY_MS);
const EXPECTED_EUR = '160';
const FROZEN_EUR = '100';

interface Fixture {
  userId: string;
  eurId: string;
  usdId: string;
  tokenId: string;
  institutionId: string;
}

async function seededId(
  table: typeof schema.tokenTypes | typeof schema.institutionTypes | typeof schema.accountTypes,
  code: string
) {
  const [row] = await db.select({ id: table.id }).from(table).where(eq(table.code, code));
  if (!row) throw new Error(`seeded ${code} row missing — is the database migrated?`);
  return row.id;
}

async function fiatId(symbol: string) {
  const [row] = await db
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .where(and(eq(schema.tokens.symbol, symbol), eq(schema.tokens.isActive, true)));
  if (!row) throw new Error(`seeded ${symbol} token missing`);
  return row.id;
}

async function setupFixture(): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const [eurId, usdId] = await Promise.all([fiatId('EUR'), fiatId('USD')]);
  const [user] = await db
    .insert(schema.users)
    .values({ email: `sc1477-${suffix}@scani.local`, name: 'EUR base', baseCurrencyId: eurId })
    .returning();
  const [institution] = await db
    .insert(schema.institutions)
    .values({ name: `SC-1477 ${suffix}`, typeId: await seededId(schema.institutionTypes, 'other') })
    .returning();
  const [account] = await db
    .insert(schema.accounts)
    .values({
      userId: user!.id,
      institutionId: institution!.id,
      name: 'Account',
      typeId: await seededId(schema.accountTypes, 'other'),
    })
    .returning();
  const [token] = await db
    .insert(schema.tokens)
    .values({
      symbol: `BC${suffix.toUpperCase()}`,
      name: 'Base-currency probe',
      typeId: await seededId(schema.tokenTypes, 'other'),
      createdByUserId: user!.id,
    })
    .returning();
  const [holding] = await db.transaction((tx) =>
    seedHoldingCache(tx, (calculator) =>
      calculator
        .insert(schema.holdings)
        .values({ userId: user!.id, accountId: account!.id, tokenId: token!.id, balance: '1' })
        .returning()
    )
  );
  await db.insert(schema.holdingTransactions).values({
    userId: user!.id,
    holdingId: holding!.id,
    tokenId: token!.id,
    kind: 'deposit',
    quantity: '1',
    occurredAt: new Date(NOW.getTime() - 40 * DAY_MS),
    externalId: `sc1477-dep-${suffix}`,
    source: 'test',
  });
  await Container.get(HoldingCoverageRepository).syncTxBoundsFromLedger([holding!.id]);

  const writer = Container.get(PriceWriter);
  await db.transaction(async (tx) => {
    await writer.writeCurrent(
      [{ tokenId: token!.id, baseTokenId: eurId, price: FROZEN_EUR, source: 'coingecko' }],
      FROZEN_AT,
      tx
    );
    await writer.writeCurrent(
      [
        { tokenId: token!.id, baseTokenId: usdId, price: '200', source: 'coingecko' },
        { tokenId: eurId, baseTokenId: usdId, price: '1.25', source: 'frankfurter' },
      ],
      AN_HOUR_AGO,
      tx
    );
  });
  await Container.get(OpeningBalanceReconciliationService).reconcileHolding(holding!.id);
  return { userId: user!.id, eurId, usdId, tokenId: token!.id, institutionId: institution!.id };
}

const money = (v: string | null | undefined) =>
  v == null ? null : new Decimal(v).toDecimalPlaces(2).toString();

describe('SC-1477: a fresh price in another base beats a stale one in the user base', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await setupFixture();
    await Container.get(RollupPortfolioValueDailyUseCase).execute({
      userId: f.userId,
      lookbackDays: 2,
      runStart: NOW,
    });
  });
  afterAll(async () => {
    if (!f) return;
    await db
      .delete(schema.portfolioValueDaily)
      .where(eq(schema.portfolioValueDaily.userId, f.userId));
    await db.delete(schema.tokenPrices).where(eq(schema.tokenPrices.tokenId, f.tokenId));
    await db
      .delete(schema.tokenPrices)
      .where(
        and(
          eq(schema.tokenPrices.tokenId, f.eurId),
          eq(schema.tokenPrices.baseTokenId, f.usdId),
          eq(schema.tokenPrices.timestamp, AN_HOUR_AGO)
        )
      );
    await db.delete(schema.users).where(eq(schema.users.id, f.userId));
    await db.delete(schema.tokens).where(eq(schema.tokens.id, f.tokenId));
    await db.delete(schema.institutions).where(eq(schema.institutions.id, f.institutionId));
  });

  test('control: the dashboard values the unit at the fresh route', async () => {
    const value = await Container.get(PortfolioValuationService).computePortfolioValueAt(f.userId, {
      at: NOW,
      userBaseCurrencyId: f.eurId,
    });
    expect(money(value.totalValue)).toBe(EXPECTED_EUR);
  });

  test("the chart's day row values it at the fresh route, not the frozen EUR row", async () => {
    const rows = await db
      .select()
      .from(schema.portfolioValueDaily)
      .where(
        and(
          eq(schema.portfolioValueDaily.userId, f.userId),
          eq(schema.portfolioValueDaily.scopeKind, 'user')
        )
      );
    const today = rows.sort((a, b) => b.snapshotDate.localeCompare(a.snapshotDate))[0];
    expect(today?.baseCurrencyId).toBe(f.eurId);
    expect(money(today?.totalValue)).toBe(EXPECTED_EUR);
  });
});
