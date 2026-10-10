import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingTransactionRepository } from '../../src/repositories/HoldingTransactionRepository';
import { InTransitService } from '../../src/services/portfolio/InTransitService';
import { withTestDb } from '../../test/helpers/db';
import { ago, travelling } from '../../test/helpers/transit';

/**
 * A transfer answered `internal` to a provider-fed holding often lands net of
 * a fee (Wise to IBKR). One provider inflow up to 10% under what was sent takes
 * over the person's arrival leg, and the shortfall is booked as a fee portion
 * on the outflow's answer. Never more than sent; two candidates are asked
 * about, never picked (SC-1675 Q2, operator #23848).
 */

const repo = () => Container.get(HoldingTransactionRepository);
type Scenario = Awaited<ReturnType<typeof travelling>>;

function inflow(t: Scenario, quantity: string, externalId = 'k-1', at = ago(4)) {
  return {
    userId: t.userId,
    holdingId: t.destination.id,
    tokenId: t.baseId,
    kind: 'deposit',
    quantity,
    occurredAt: at,
    source: 'kraken',
    externalId,
  };
}

async function state(tx: DatabaseTransaction, t: Scenario) {
  const rows = await tx
    .select()
    .from(schema.holdingTransactions)
    .where(eq(schema.holdingTransactions.holdingId, t.destination.id));
  const [outflow] = await tx
    .select()
    .from(schema.holdingTransactions)
    .where(eq(schema.holdingTransactions.id, t.outflowId));
  return {
    rows: rows
      .map((r) => ({
        source: r.source,
        quantity: String(Number(r.quantity)),
        group: r.transferGroupId,
      }))
      .sort((a, b) => a.source.localeCompare(b.source)),
    answer: outflow!.transferReview,
    split: outflow!.transferReviewSplit,
  };
}

describe('a provider inflow up to 10% under what was sent takes over the arrival', () => {
  test('485 of 500 takes over the leg and books 15 as a fee', async () => {
    await withTestDb(async (tx) => {
      const t = await travelling(tx);
      await repo().bulkUpsert([inflow(t, '485')], tx);
      expect(await state(tx, t)).toEqual({
        rows: [{ source: 'kraken', quantity: '485', group: t.groupId }],
        answer: 'split',
        split: [
          {
            decision: 'internal',
            quantity: '485',
            destination: { accountId: t.destinationAccount.id, holdingId: t.destination.id },
          },
          { decision: 'fee', quantity: '15' },
        ],
      });
    });
  });

  test('the arrived units travelled until the arrival; the fee left at the outflow', async () => {
    await withTestDb(async (tx) => {
      const t = await travelling(tx);
      await repo().bulkUpsert([inflow(t, '485')], tx);
      const amounts = await Container.get(InTransitService).amountsAt(
        t.userId,
        [ago(4.5), ago(2)],
        tx
      );
      expect(amounts.map((a) => [a.at.getTime(), a.quantity.toFixed()])).toEqual([
        [ago(4.5).getTime(), '485'],
      ]);
    });
  });

  test('exactly 10% under still takes over', async () => {
    await withTestDb(async (tx) => {
      const t = await travelling(tx);
      await repo().bulkUpsert([inflow(t, '450')], tx);
      const s = await state(tx, t);
      expect({ rows: s.rows.length, answer: s.answer }).toEqual({ rows: 1, answer: 'split' });
    });
  });

  test('more than 10% under is different money', async () => {
    await withTestDb(async (tx) => {
      const t = await travelling(tx);
      await repo().bulkUpsert([inflow(t, '449.99')], tx);
      const s = await state(tx, t);
      expect({ rows: s.rows.map((r) => r.source), answer: s.answer, split: s.split }).toEqual({
        rows: ['kraken', 'transfer-review'],
        answer: 'internal',
        split: null,
      });
    });
  });

  test('more than was sent is never taken over', async () => {
    await withTestDb(async (tx) => {
      const t = await travelling(tx);
      await repo().bulkUpsert([inflow(t, '501')], tx);
      const s = await state(tx, t);
      expect({ rows: s.rows.length, answer: s.answer }).toEqual({ rows: 2, answer: 'internal' });
    });
  });

  test('two candidates in range are asked about, never picked', async () => {
    await withTestDb(async (tx) => {
      const t = await travelling(tx);
      await repo().bulkUpsert([inflow(t, '490', 'k-1'), inflow(t, '495', 'k-2', ago(3))], tx);
      const s = await state(tx, t);
      expect({ rows: s.rows.length, answer: s.answer }).toEqual({ rows: 3, answer: 'internal' });
    });
  });

  test('outside the 7-day window is not the same money', async () => {
    await withTestDb(async (tx) => {
      const t = await travelling(tx);
      await repo().bulkUpsert([inflow(t, '485', 'k-1', ago(5.5))], tx);
      const s = await state(tx, t);
      expect({ rows: s.rows.length, answer: s.answer }).toEqual({ rows: 2, answer: 'internal' });
    });
  });

  test('control: the exact amount takes over and the answer stays internal', async () => {
    await withTestDb(async (tx) => {
      const t = await travelling(tx);
      await repo().bulkUpsert([inflow(t, '500')], tx);
      expect(await state(tx, t)).toEqual({
        rows: [{ source: 'kraken', quantity: '500', group: t.groupId }],
        answer: 'internal',
        split: null,
      });
    });
  });

  test('a split answer keeps its other parts and gains the fee', async () => {
    await withTestDb(async (tx) => {
      const t = await travelling(tx);
      await tx
        .update(schema.holdingTransactions)
        .set({
          transferReview: 'split',
          transferReviewSplit: [
            {
              decision: 'internal',
              quantity: '300',
              destination: { accountId: t.destinationAccount.id, holdingId: t.destination.id },
            },
            { decision: 'left_control', quantity: '200' },
          ],
        })
        .where(eq(schema.holdingTransactions.id, t.outflowId));
      await tx
        .update(schema.holdingTransactions)
        .set({ quantity: '300' })
        .where(eq(schema.holdingTransactions.holdingId, t.destination.id));

      await repo().bulkUpsert([inflow(t, '297')], tx);
      expect((await state(tx, t)).split).toEqual([
        {
          decision: 'internal',
          quantity: '297',
          destination: { accountId: t.destinationAccount.id, holdingId: t.destination.id },
        },
        { decision: 'left_control', quantity: '200' },
        { decision: 'fee', quantity: '3' },
      ]);
    });
  });
});
