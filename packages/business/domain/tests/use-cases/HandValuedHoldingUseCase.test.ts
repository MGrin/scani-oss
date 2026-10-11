/**
 * SC-1596: a hand-valued holding is edited in money, never in units. "Update
 * value" moves the price per unit and so shows as gain; "money in / out" buys
 * or sells units at that day's price and so shows as a flow. Real database,
 * rolled back; nothing stubbed.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import type Decimal from 'decimal.js';
import { and, eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingCoverageRepository } from '../../src/repositories/HoldingCoverageRepository';
import { PnLAtTimeService } from '../../src/services/portfolio/PnLAtTimeService';
import { PriceWriter } from '../../src/services/pricing/PriceWriter';
import {
  HandValuedHoldingUseCase,
  NoPriceYetError,
  NotHandValuedError,
  NothingHeldThenError,
} from '../../src/use-cases/HandValuedHoldingUseCase';
import { withTestDb } from '../../test/helpers/db';
import { seedHoldingCache } from '../../test/helpers/engine-guard';
import { seedReading } from '../../test/helpers/factories-extra';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const day = (offset: number) => new Date(NOW + offset * DAY_MS);
const iso = (offset: number) => day(offset).toISOString();

interface Fixture {
  userId: string;
  usdId: string;
  fundHoldingId: string;
  cashHoldingId: string;
}

async function seededId(
  table: typeof schema.tokenTypes | typeof schema.institutionTypes | typeof schema.accountTypes,
  code: string,
  tx: DatabaseTransaction
) {
  const [row] = await tx.select({ id: table.id }).from(table).where(eq(table.code, code));
  if (!row) throw new Error(`seeded ${code} row missing — is the database migrated?`);
  return row.id;
}

/** 100 units bought at 10 thirty days ago; worth 1000, basis 1000. */
async function setupFixture(tx: DatabaseTransaction): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const [usd] = await tx
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .where(and(eq(schema.tokens.symbol, 'USD'), eq(schema.tokens.isActive, true)));
  if (!usd) throw new Error('seeded USD token missing');

  const [user] = await tx
    .insert(schema.users)
    .values({ email: `hv-${suffix}@scani.local`, name: 'Hand valued', baseCurrencyId: usd.id })
    .returning();
  const [institution] = await tx
    .insert(schema.institutions)
    .values({
      name: `Fund ${suffix}`,
      typeId: await seededId(schema.institutionTypes, 'other', tx),
    })
    .returning();
  const [account] = await tx
    .insert(schema.accounts)
    .values({
      userId: user!.id,
      institutionId: institution!.id,
      name: 'Fund account',
      typeId: await seededId(schema.accountTypes, 'other', tx),
    })
    .returning();
  const [fund] = await tx
    .insert(schema.tokens)
    .values({
      symbol: `HV${suffix.toUpperCase()}`,
      name: 'Hand-valued fund',
      typeId: await seededId(schema.tokenTypes, 'other', tx),
      createdByUserId: user!.id,
      providerMetadata: { provider: 'manual' },
    })
    .returning();
  const rows = await seedHoldingCache(tx, (calculator) =>
    calculator
      .insert(schema.holdings)
      .values([
        { userId: user!.id, accountId: account!.id, tokenId: fund!.id, balance: '100' },
        { userId: user!.id, accountId: account!.id, tokenId: usd.id, balance: '500' },
      ])
      .returning()
  );
  const fundHolding = rows.find((h) => h.tokenId === fund!.id)!;
  const cashHolding = rows.find((h) => h.tokenId === usd.id)!;

  await tx.insert(schema.holdingTransactions).values({
    userId: user!.id,
    holdingId: fundHolding.id,
    tokenId: fund!.id,
    kind: 'deposit',
    quantity: '100',
    priceNative: '10',
    priceNativeTokenId: usd.id,
    occurredAt: day(-30),
    externalId: `hv-dep-${suffix}`,
    source: 'test',
  });
  // The reading a funded holding has carried since A2; without it the engine
  // holds the first edit's figure back over the deposit (SC-1637).
  await seedReading(tx, {
    userId: user!.id,
    holdingId: fundHolding.id,
    balance: '100',
    at: day(-30),
  });
  await Container.get(HoldingCoverageRepository).syncTxBoundsFromLedger([fundHolding.id], tx);
  await Container.get(PriceWriter).writeManual(
    {
      tokenId: fund!.id,
      baseTokenId: usd.id,
      price: '10',
      at: day(-30),
      granularity: 'intraday',
      source: 'manual',
    },
    tx
  );

  return {
    userId: user!.id,
    usdId: usd.id,
    fundHoldingId: fundHolding.id,
    cashHoldingId: cashHolding.id,
  };
}

const money = (d: Decimal | null | undefined) => d?.toDecimalPlaces(2).toString() ?? null;

async function fundPnl(f: Fixture, tx: DatabaseTransaction) {
  const pnl = await Container.get(PnLAtTimeService).getPnL(f.userId, new Date(), f.usdId, { tx });
  const fund = pnl.perHolding.find((h) => h.holdingId === f.fundHoldingId);
  return {
    value: money(fund?.value),
    basis: money(fund?.costBasis),
    unrealized: money(fund?.unrealizedPnl),
    realized: money(fund?.realizedPnl),
  };
}

async function balanceOf(holdingId: string, tx: DatabaseTransaction) {
  const [row] = await tx
    .select({ balance: schema.holdings.balance })
    .from(schema.holdings)
    .where(eq(schema.holdings.id, holdingId));
  return Number(row!.balance);
}

const useCase = () => Container.get(HandValuedHoldingUseCase);

describe('SC-1596 hand-valued holdings', () => {
  test('the fixture is worth 1000 with no gain — the control every case moves from', async () => {
    await withTestDb(async (tx) => {
      const f = await setupFixture(tx);
      expect(await fundPnl(f, tx)).toEqual({
        value: '1000',
        basis: '1000',
        unrealized: '0',
        realized: '0',
      });
    });
  });

  test('update value +350 moves value and gain by 350, flows unchanged', async () => {
    await withTestDb(async (tx) => {
      const f = await setupFixture(tx);
      await useCase().updateValue(
        { holdingId: f.fundHoldingId, value: '1350', currencyCode: 'USD', occurredAt: iso(-1) },
        f.userId,
        tx
      );
      expect(await fundPnl(f, tx)).toEqual({
        value: '1350',
        basis: '1000',
        unrealized: '350',
        realized: '0',
      });
      expect(await balanceOf(f.fundHoldingId, tx)).toBe(100);
    });
  });

  test('money in +350 moves value and flows by 350, gain unchanged', async () => {
    await withTestDb(async (tx) => {
      const f = await setupFixture(tx);
      await useCase().moveMoney(
        {
          holdingId: f.fundHoldingId,
          direction: 'in',
          amount: '350',
          currencyCode: 'USD',
          occurredAt: iso(-1),
        },
        f.userId,
        tx
      );
      expect(await fundPnl(f, tx)).toEqual({
        value: '1350',
        basis: '1350',
        unrealized: '0',
        realized: '0',
      });
      expect(await balanceOf(f.fundHoldingId, tx)).toBe(135);
    });
  });

  test('money out sells units at that day’s price, so it realizes the gain it carries', async () => {
    await withTestDb(async (tx) => {
      const f = await setupFixture(tx);
      await useCase().updateValue(
        { holdingId: f.fundHoldingId, value: '1250', currencyCode: 'USD', occurredAt: iso(-2) },
        f.userId,
        tx
      );
      // 12.5 a unit: 250 out is 20 units, which cost 200.
      await useCase().moveMoney(
        {
          holdingId: f.fundHoldingId,
          direction: 'out',
          amount: '250',
          currencyCode: 'USD',
          occurredAt: iso(-1),
        },
        f.userId,
        tx
      );
      expect(await fundPnl(f, tx)).toEqual({
        value: '1000',
        basis: '800',
        unrealized: '200',
        realized: '50',
      });
      expect(await balanceOf(f.fundHoldingId, tx)).toBe(80);
    });
  });

  test('a past value divides by the units held THEN, not today', async () => {
    await withTestDb(async (tx) => {
      const f = await setupFixture(tx);
      // 35 units arrive on day -5; a value dated day -10 still covers 100.
      await useCase().moveMoney(
        {
          holdingId: f.fundHoldingId,
          direction: 'in',
          amount: '350',
          currencyCode: 'USD',
          occurredAt: iso(-5),
        },
        f.userId,
        tx
      );
      await useCase().updateValue(
        { holdingId: f.fundHoldingId, value: '1100', currencyCode: 'USD', occurredAt: iso(-10) },
        f.userId,
        tx
      );
      const prices = await tx
        .select({ price: schema.tokenPrices.price, at: schema.tokenPrices.timestamp })
        .from(schema.tokenPrices)
        .innerJoin(schema.holdings, eq(schema.holdings.tokenId, schema.tokenPrices.tokenId))
        .where(eq(schema.holdings.id, f.fundHoldingId));
      const atMinus10 = prices.find((p) => Math.abs(p.at.getTime() - day(-10).getTime()) < 1000);
      expect(Number(atMinus10?.price)).toBe(11);
      // The 350 put in on day -5 stays 350 of basis, though day -5 now
      // reads 11 a unit: a flow is valued at what was typed, not re-priced.
      expect((await fundPnl(f, tx)).basis).toBe('1350');
    });
  });

  test('a value dated before anything was held is refused', async () => {
    await withTestDb(async (tx) => {
      const f = await setupFixture(tx);
      await expect(
        useCase().updateValue(
          { holdingId: f.fundHoldingId, value: '500', currencyCode: 'USD', occurredAt: iso(-40) },
          f.userId,
          tx
        )
      ).rejects.toBeInstanceOf(NothingHeldThenError);
    });
  });

  test('money dated before the first value has no price to convert at and is refused', async () => {
    await withTestDb(async (tx) => {
      const f = await setupFixture(tx);
      await expect(
        useCase().moveMoney(
          {
            holdingId: f.fundHoldingId,
            direction: 'in',
            amount: '100',
            currencyCode: 'USD',
            occurredAt: iso(-40),
          },
          f.userId,
          tx
        )
      ).rejects.toBeInstanceOf(NoPriceYetError);
    });
  });

  test('a holding whose price comes from a market is refused', async () => {
    await withTestDb(async (tx) => {
      const f = await setupFixture(tx);
      await expect(
        useCase().updateValue(
          { holdingId: f.cashHoldingId, value: '600', currencyCode: 'USD', occurredAt: iso(-1) },
          f.userId,
          tx
        )
      ).rejects.toBeInstanceOf(NotHandValuedError);
    });
  });

  test('another user cannot touch the holding', async () => {
    await withTestDb(async (tx) => {
      const f = await setupFixture(tx);
      await expect(
        useCase().updateValue(
          { holdingId: f.fundHoldingId, value: '600', currencyCode: 'USD', occurredAt: iso(-1) },
          randomUUID(),
          tx
        )
      ).rejects.toBeInstanceOf(NotHandValuedError);
    });
  });
});
