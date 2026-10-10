import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { EngineEvidenceRepository } from '../../../src/repositories/EngineEvidenceRepository';
import { HoldingCoverageRepository } from '../../../src/repositories/HoldingCoverageRepository';
import { PnLAtTimeService } from '../../../src/services/portfolio/PnLAtTimeService';
import { PortfolioValuationAtTimeService } from '../../../src/services/portfolio/PortfolioValuationAtTimeService';
import { PriceReader } from '../../../src/services/pricing/PriceReader';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { withTestDb } from '../../../test/helpers/db';
import { seedHoldingCache } from '../../../test/helpers/engine-guard';
import { countingStatements } from '../../../test/helpers/statement-count';

/**
 * The history valuation reads `priceAt` through one series (foundation A3,
 * Task 20): the nearest reading at or before each day's close, daily or not,
 * stale by the engine's horizons (D-14), and never a pair's history.
 */

restoreContainerAfterAll();

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY = Date.UTC(2026, 6, 15);
const close = (offset: number) => new Date(DAY + offset * DAY_MS + DAY_MS - 1);
const NOW = new Date(DAY + 60 * DAY_MS);

interface Fixture {
  userId: string;
  usdId: string;
  coinId: string;
  holdingId: string;
  accountId: string;
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

async function setup(tx: DatabaseTransaction, ledgerRows = 1): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const [usd] = await tx
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .where(and(eq(schema.tokens.symbol, 'USD'), eq(schema.tokens.isActive, true)));
  if (!usd) throw new Error('seeded USD token missing');
  const [user] = await tx
    .insert(schema.users)
    .values({ email: `series-${suffix}@scani.local`, name: 'Series', baseCurrencyId: usd.id })
    .returning();
  const [institution] = await tx
    .insert(schema.institutions)
    .values({
      name: `Series ${suffix}`,
      typeId: await seededId(schema.institutionTypes, 'other', tx),
    })
    .returning();
  const [account] = await tx
    .insert(schema.accounts)
    .values({
      userId: user!.id,
      institutionId: institution!.id,
      name: 'Series account',
      typeId: await seededId(schema.accountTypes, 'other', tx),
    })
    .returning();
  const [coin] = await tx
    .insert(schema.tokens)
    .values({
      symbol: `SER${suffix.toUpperCase()}`,
      name: 'Series coin',
      typeId: await seededId(schema.tokenTypes, 'crypto', tx),
    })
    .returning();
  const [holding] = await seedHoldingCache(tx, (calculator) =>
    calculator
      .insert(schema.holdings)
      .values({
        userId: user!.id,
        accountId: account!.id,
        tokenId: coin!.id,
        balance: String(2 * ledgerRows),
      })
      .returning()
  );
  await tx.insert(schema.holdingTransactions).values(
    Array.from({ length: ledgerRows }, (_, i) => ({
      userId: user!.id,
      holdingId: holding!.id,
      tokenId: coin!.id,
      kind: 'deposit',
      quantity: '2',
      occurredAt: new Date(DAY - (ledgerRows - i) * DAY_MS + 10 * 60 * 60 * 1000),
      externalId: `series-${suffix}-${i}`,
      source: 'test',
    }))
  );
  await Container.get(HoldingCoverageRepository).syncTxBoundsFromLedger([holding!.id], tx);
  return {
    userId: user!.id,
    usdId: usd.id,
    coinId: coin!.id,
    holdingId: holding!.id,
    accountId: account!.id,
  };
}

async function price(
  tx: DatabaseTransaction,
  f: Fixture,
  value: string,
  at: Date,
  granularity: 'daily' | 'intraday'
) {
  await tx.insert(schema.tokenPrices).values({
    tokenId: f.coinId,
    baseTokenId: f.usdId,
    price: value,
    timestamp: at,
    granularity,
    source: 'test',
  });
}

describe('the history valuation reads one series', () => {
  test('a day is priced at the nearest reading at or before its close, daily or not', async () => {
    await withTestDb(async (tx) => {
      const f = await setup(tx);
      await price(tx, f, '100', close(-3), 'daily');
      await price(tx, f, '110', new Date(DAY + 10 * 60 * 60 * 1000), 'intraday');
      const result = await new PortfolioValuationAtTimeService().getPortfolioValue(
        f.userId,
        close(0),
        f.usdId,
        { tx }
      );
      expect(result.totalValueInBase.toString()).toBe('220');
      expect(result.perHolding[0]?.priceStale).toBe(false);
    });
  });

  test('a day close with a five-day-old crypto price counts as stale', async () => {
    await withTestDb(async (tx) => {
      const f = await setup(tx);
      await price(tx, f, '100', close(-5), 'daily');
      const result = await new PortfolioValuationAtTimeService().getPortfolioValue(
        f.userId,
        close(0),
        f.usdId,
        { tx }
      );
      expect(result.totalValueInBase.toString()).toBe('200');
      expect(result.perHolding[0]?.priceStale).toBe(true);
      expect(result.holdingsStalePriced).toBe(1);
      expect(result.coverageQuality).toBe('partial');
    });
  });

  test('a 30-day chunk over pairs with 10,000 intraday rows loads at most two rows per pair and day', async () => {
    await withTestDb(async (tx) => {
      const f = await setup(tx);
      await tx.execute(sql`
        INSERT INTO token_prices (token_id, base_token_id, price, timestamp, granularity, source)
        SELECT ${f.coinId}::uuid, ${f.usdId}::uuid, (100 + n % 7)::text,
               ${new Date(DAY - DAY_MS).toISOString()}::timestamptz + n * interval '259 seconds',
               'intraday', 'test'
          FROM generate_series(0, 9999) AS n`);
      const evidence = Container.get(EngineEvidenceRepository);
      const reader = Container.get(PriceReader);
      const loaded: Array<{ tokenId: string; baseTokenId: string }> = [];
      const read = evidence.findPriceReadingsAtInstants.bind(evidence);
      // Put back before the next test: a later getPnL reading `firstReadingAt` through
      // this PriceReader failed whenever it was the first to build the drift
      // service (CI's selected-file runs; SC-1671).
      try {
        // Inherits from the real repository, so every method it does not
        // override still answers (a spread would drop them all).
        const counting = Object.create(evidence) as EngineEvidenceRepository;
        counting.findPriceReadingsAtInstants = async (...args: Parameters<typeof read>) => {
          const readings = await read(...args);
          loaded.push(...readings);
          return readings;
        };
        Container.set(EngineEvidenceRepository, counting);
        Container.set(PriceReader, new PriceReader());
        const valuation = new PortfolioValuationAtTimeService();
        const days = Array.from({ length: 30 }, (_, i) => close(i));
        const prices = await Container.get(PriceReader).series(
          await valuation.priceAsks(f.userId, days, { tx }),
          f.usdId,
          tx
        );
        for (const at of days) {
          await valuation.getPortfolioValue(f.userId, at, f.usdId, { prices, tx });
        }
        const ownPair = loaded.filter((r) => r.tokenId === f.coinId && r.baseTokenId === f.usdId);
        expect(ownPair.length).toBeGreaterThan(0);
        expect(ownPair.length).toBeLessThanOrEqual(2 * days.length);
      } finally {
        Container.set(EngineEvidenceRepository, evidence);
        Container.set(PriceReader, reader);
      }
    });
  });

  test('getPnL loads in the same number of statements for 20 and 1,500 ledger rows', async () => {
    const statementsFor = (rows: number) =>
      withTestDb(async (tx) => {
        const f = await setup(tx, rows);
        await price(tx, f, '100', close(-1), 'daily');
        const counting = countingStatements(tx);
        await new PnLAtTimeService().getPnL(f.userId, close(0), f.usdId, {
          now: NOW,
          tx: counting.handle,
        });
        return counting.started();
      });
    const few = await statementsFor(20);
    const many = await statementsFor(1500);
    expect(few).toBeGreaterThan(0);
    expect(many).toBe(few);
  });
});
