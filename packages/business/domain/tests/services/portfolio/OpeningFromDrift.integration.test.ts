/**
 * Feeds foundation A5 deletes every stored `opening_balance` row (Ops O1).
 * These pin what that relies on: the drift ledger already books a holding's
 * opening as its first reading less the ledger up to it, so the cost walk
 * and P&L read the same figures once the row is gone.
 *
 * Every close carries a different price, so a lot valued on the wrong day
 * shows up as a different cost, not as an equal one.
 */

import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { Decimal } from '@scani/shared';
import { and, eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { PnLAtTimeService } from '../../../src/services/portfolio/PnLAtTimeService';
import { CostBasisService } from '../../../src/services/pricing/CostBasisService';
import { DriftLedgerService, withDrift } from '../../../src/services/returns/DriftLedgerService';
import { withTestDb } from '../../../test/helpers/db';
import { seedHoldingCache } from '../../../test/helpers/engine-guard';

interface Fixture {
  userId: string;
  baseId: string;
  tokenId: string;
  holdingId: string;
}

const closeOf = (day: Date) =>
  new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 23, 59, 59, 999));

async function seed(tx: DatabaseTransaction, balance: string): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const [tokenType] = await tx
    .insert(schema.tokenTypes)
    .values({ code: `a5o-${suffix}`, name: 'A5 opening type' })
    .returning();
  const [institutionType] = await tx
    .insert(schema.institutionTypes)
    .values({ code: `a5o-i-${suffix}`, name: 'A5 opening institution type' })
    .returning();
  const [accountType] = await tx
    .insert(schema.accountTypes)
    .values({ code: `a5o-a-${suffix}`, name: 'A5 opening account type' })
    .returning();
  const [base, held] = await tx
    .insert(schema.tokens)
    .values([
      { symbol: `A5B${suffix.toUpperCase()}`, name: 'A5 base', typeId: tokenType!.id },
      { symbol: `A5H${suffix.toUpperCase()}`, name: 'A5 held', typeId: tokenType!.id },
    ])
    .returning();
  const [institution] = await tx
    .insert(schema.institutions)
    .values({ name: 'A5 institution', typeId: institutionType!.id })
    .returning();
  const [user] = await tx
    .insert(schema.users)
    .values({ email: `a5o-${suffix}@scani.local`, name: 'A5', baseCurrencyId: base!.id })
    .returning();
  const [account] = await tx
    .insert(schema.accounts)
    .values({
      userId: user!.id,
      institutionId: institution!.id,
      name: 'A5 account',
      typeId: accountType!.id,
    })
    .returning();
  const [holding] = await seedHoldingCache(tx, (calculator) =>
    calculator
      .insert(schema.holdings)
      .values({ userId: user!.id, accountId: account!.id, tokenId: held!.id, balance })
      .returning()
  );
  return { userId: user!.id, baseId: base!.id, tokenId: held!.id, holdingId: holding!.id };
}

/** One daily close per `[day, price]`. */
async function closes(
  tx: DatabaseTransaction,
  f: Fixture,
  prices: ReadonlyArray<readonly [Date, string]>
) {
  await tx.insert(schema.tokenPrices).values(
    prices.map(([day, price]) => ({
      tokenId: f.tokenId,
      baseTokenId: f.baseId,
      price,
      timestamp: closeOf(day),
      granularity: 'daily' as const,
      source: 'test',
    }))
  );
}

async function reading(tx: DatabaseTransaction, f: Fixture, balance: string, observedAt: Date) {
  await tx.insert(schema.holdingBalanceObservations).values({
    userId: f.userId,
    holdingId: f.holdingId,
    balance,
    observedAt,
    source: 'provider-sync',
  });
}

async function row(
  tx: DatabaseTransaction,
  f: Fixture,
  values: { kind: string; quantity: string; occurredAt: Date; priceNative?: string }
) {
  await tx.insert(schema.holdingTransactions).values({
    userId: f.userId,
    holdingId: f.holdingId,
    tokenId: f.tokenId,
    kind: values.kind,
    quantity: values.quantity,
    occurredAt: values.occurredAt,
    priceNative: values.priceNative ?? null,
    priceNativeTokenId: values.priceNative ? f.baseId : null,
    source: 'test',
    externalId: `a5o-${randomUUID()}`,
  });
}

async function storedOpening(tx: DatabaseTransaction, f: Fixture, quantity: string, at: Date) {
  await tx.insert(schema.holdingTransactions).values({
    userId: f.userId,
    holdingId: f.holdingId,
    tokenId: f.tokenId,
    kind: 'opening_balance',
    quantity,
    occurredAt: at,
    source: 'reconciliation-opening',
    externalId: 'opening_balance',
  });
}

async function deleteStoredOpening(tx: DatabaseTransaction, f: Fixture) {
  await tx
    .delete(schema.holdingTransactions)
    .where(
      and(
        eq(schema.holdingTransactions.holdingId, f.holdingId),
        eq(schema.holdingTransactions.kind, 'opening_balance')
      )
    );
}

/** The drift rows, and the cost walk over the ledger P&L builds: stored rows plus drift. */
async function walk(tx: DatabaseTransaction, f: Fixture, at: Date) {
  const ledger = await Container.get(HoldingTransactionRepository).findForHoldingsAll(
    [f.holdingId],
    tx
  );
  const drift = await Container.get(DriftLedgerService).forHoldings(
    f.userId,
    new Map([[f.holdingId, f.tokenId]]),
    { transactions: ledger, tx }
  );
  const txs = withDrift(ledger, drift).get(f.holdingId) ?? [];
  const cost = await Container.get(CostBasisService).getCostBasis(f.holdingId, at, f.baseId, {
    now: at,
    heldTokenId: f.tokenId,
    txs,
    tx,
  });
  const pnl = await Container.get(PnLAtTimeService).getPnL(f.userId, at, f.baseId, {
    now: at,
    tx,
  });
  return {
    drift: (drift.get(f.holdingId) ?? []).map((d) => [d.kind, d.quantity]),
    lots: cost.lots.map((l) => new Decimal(l.qty).toString()),
    unpriced: cost.lots.filter((l) => l.unpriced).length,
    openQty: new Decimal(cost.openQty).toString(),
    costBasis: new Decimal(cost.costBasis),
    realizedPnl: new Decimal(cost.realizedPnl),
    pnlCostBasis: pnl.perHolding.find((p) => p.holdingId === f.holdingId)?.costBasis ?? null,
  };
}

const JAN = (day: number) => new Date(Date.UTC(2026, 0, day, 12));
/** Jan n closes at 100 + n. */
const JAN_CLOSES = Array.from({ length: 10 }, (_, i) => [JAN(i + 1), String(101 + i)] as const);

/** +2 bought on Jan 3 at 103, a first reading of 10 on Jan 5. */
async function janHolding(tx: DatabaseTransaction) {
  const f = await seed(tx, '10');
  await closes(tx, f, JAN_CLOSES);
  await row(tx, f, { kind: 'buy', quantity: '2', occurredAt: JAN(3), priceNative: '103' });
  await reading(tx, f, '10', JAN(5));
  return f;
}

describe('an opening without its stored row (A5)', () => {
  test('an uncapped opening: deleting the stored row leaves cost basis and units unchanged', async () => {
    await withTestDb(async (tx) => {
      const f = await janHolding(tx);
      await storedOpening(tx, f, '8', new Date(JAN(3).getTime() - 1));
      const at = closeOf(JAN(10));

      const before = await walk(tx, f, at);
      await deleteStoredOpening(tx, f);
      const after = await walk(tx, f, at);

      // The control: the stored row explained the reading, so it was read and
      // no drift opening was booked beside it.
      expect(before.drift).toEqual([]);
      expect(after.drift).toEqual([['drift_in', '8']]);
      // 8 at Jan 3's close (103) plus 2 bought at 103.
      expect(before.costBasis.toString()).toBe('1030');
      expect(after.costBasis.eq(before.costBasis)).toBe(true);
      expect(after.pnlCostBasis?.eq(before.pnlCostBasis ?? new Decimal(-1))).toBe(true);
      expect([before.openQty, after.openQty]).toEqual(['10', '10']);
      expect([before.unpriced, after.unpriced]).toEqual([0, 0]);
    });
  });

  test('a capped opening: one lot of the same total and cost replaces row plus drift', async () => {
    await withTestDb(async (tx) => {
      const f = await janHolding(tx);
      await storedOpening(tx, f, '5', new Date(JAN(3).getTime() - 1));
      const at = closeOf(JAN(10));

      const before = await walk(tx, f, at);
      await deleteStoredOpening(tx, f);
      const after = await walk(tx, f, at);

      // Today: drift tops the capped row up to the reading.
      expect(before.drift).toEqual([['drift_in', '3']]);
      expect(before.lots).toEqual(['3', '5', '2']);
      expect(after.drift).toEqual([['drift_in', '8']]);
      expect(after.lots).toEqual(['8', '2']);
      expect(before.costBasis.toString()).toBe('1030');
      expect(after.costBasis.eq(before.costBasis)).toBe(true);
      expect(after.pnlCostBasis?.eq(before.pnlCostBasis ?? new Decimal(-1))).toBe(true);
    });
  });

  test('a first reading at UTC midnight opens before a same-instant row', async () => {
    await withTestDb(async (tx) => {
      const midnight = new Date('2026-03-01T00:00:00Z');
      const f = await seed(tx, '10');
      // Feb 28 closes at 119 and Mar 1 at 120, so the day the opening is
      // valued on is visible in its cost.
      await closes(tx, f, [
        [new Date('2026-02-27T12:00:00Z'), '118'],
        [new Date('2026-02-28T12:00:00Z'), '119'],
        [new Date('2026-03-01T12:00:00Z'), '120'],
        [new Date('2026-03-02T12:00:00Z'), '121'],
        [new Date('2026-03-03T12:00:00Z'), '122'],
      ]);
      await reading(tx, f, '10', midnight);
      await row(tx, f, { kind: 'sell', quantity: '-1', occurredAt: midnight, priceNative: '110' });
      const at = closeOf(new Date(Date.UTC(2026, 2, 3, 12)));

      const after = await walk(tx, f, at);

      // First reading 10 less the ledger up to it (-1) opens 11, booked at the
      // reading's own instant and met before the sell.
      expect(after.drift).toEqual([['drift_in', '11']]);
      expect(after.unpriced).toBe(0);
      expect(after.openQty).toBe('10');
      // 11 at Mar 1's close (120), less the 1 sold at that lot's cost.
      expect(after.costBasis.toString()).toBe('1200');
      expect(after.realizedPnl.toString()).toBe('-10');
    });
  });
});
