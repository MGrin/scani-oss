import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { desc, eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { BalanceGapService } from '../../../src/services/holdings/BalanceGapService';
import { TransitReviewService } from '../../../src/services/portfolio/TransitReviewService';
import { withTestDb } from '../../../test/helpers/db';
import { makeHoldingTransaction, seedReading } from '../../../test/helpers/factories-extra';
import { ago, travelling } from '../../../test/helpers/transit';

/**
 * One question per transfer (SC-1680, operator #23993). A transfer in transit
 * leaves the destination's provider reading short of the person's arrival leg,
 * which the balance-change queue used to ask about from day 1, beside the
 * day-7 transit question about the same money. While the money travels, that
 * interval waits on the transit question; once the transit is answered, the
 * queue asks the right question about whatever is left, or none.
 */

const gaps = () => Container.get(BalanceGapService);
const transits = () => Container.get(TransitReviewService);
type Scenario = Awaited<ReturnType<typeof travelling>>;

/** Sent 9 days ago; the provider reads the destination at `balance` the next day. */
async function late(tx: DatabaseTransaction, balance = '1000') {
  const t = await travelling(tx, { sentDaysAgo: 9 });
  await seedReading(tx, {
    userId: t.userId,
    holdingId: t.destination.id,
    balance,
    at: ago(8),
    authority: 'provider',
  });
  return t;
}

async function questions(tx: DatabaseTransaction, t: Scenario) {
  const listing = await gaps().listPending(t.userId, new Date(), tx);
  return {
    destination: listing.items.filter((item) => item.holdingId === t.destination.id),
    source: listing.items.filter((item) => item.holdingId === t.source.id),
    suppressed: listing.suppressed,
  };
}

describe('the balance-change queue while a transfer is in transit (SC-1680)', () => {
  test('in transit: no balance-change question on either side, counted as in transit', async () => {
    await withTestDb(async (tx) => {
      const t = await late(tx);
      const asked = await questions(tx, t);
      expect(asked.destination).toEqual([]);
      expect(asked.source).toEqual([]);
      expect(asked.suppressed['in-transit']).toBe(1);
    });
  });

  test('in transit with another 300 missing too: the interval still waits on the transit question', async () => {
    await withTestDb(async (tx) => {
      const t = await late(tx, '700');
      const asked = await questions(tx, t);
      expect(asked.destination).toEqual([]);
      expect(asked.suppressed['in-transit']).toBe(1);
    });
  });

  test('answering the skipped gap is refused: the transit question owns that money', async () => {
    await withTestDb(async (tx) => {
      const t = await late(tx);
      const [observation] = await tx
        .select({ id: schema.holdingBalanceObservations.id })
        .from(schema.holdingBalanceObservations)
        .where(eq(schema.holdingBalanceObservations.holdingId, t.destination.id))
        .orderBy(desc(schema.holdingBalanceObservations.observedAt))
        .limit(1);
      const outcome = await gaps().answer(
        t.userId,
        { observationId: observation!.id, answer: 'flow' },
        new Date(),
        tx
      );
      expect(outcome).toEqual({ refusal: 'no-longer-a-gap' });
    });
  });

  test("after 'lost': nothing is left to ask about", async () => {
    await withTestDb(async (tx) => {
      const t = await late(tx);
      expect(
        await transits().lost(
          t.userId,
          { outflowId: t.outflowId, destinationHoldingId: t.destination.id },
          'fee',
          tx
        )
      ).toMatchObject({ ok: true });
      const asked = await questions(tx, t);
      expect(asked.destination).toEqual([]);
      expect(asked.source).toEqual([]);
      expect(asked.suppressed['in-transit']).toBe(0);
    });
  });

  test("after 'lost' with another 300 missing: one question, for the 300", async () => {
    await withTestDb(async (tx) => {
      const t = await late(tx, '700');
      expect(
        await transits().lost(
          t.userId,
          { outflowId: t.outflowId, destinationHoldingId: t.destination.id },
          'fee',
          tx
        )
      ).toMatchObject({ ok: true });
      const asked = await questions(tx, t);
      expect(asked.destination.map((item) => item.drift)).toEqual(['-300']);
      expect(asked.source).toEqual([]);
    });
  });

  test("after 'came back': nothing is left to ask about on either side", async () => {
    await withTestDb(async (tx) => {
      const t = await late(tx);
      const back = await makeHoldingTransaction(tx, {
        userId: t.userId,
        holdingId: t.source.id,
        tokenId: t.baseId,
        kind: 'deposit',
        quantity: '500',
        occurredAt: ago(6),
        source: 'wise',
        externalId: `w-500-${ago(6).getTime()}`,
      });
      expect(
        await transits().cameBack(
          t.userId,
          { outflowId: t.outflowId, destinationHoldingId: t.destination.id },
          back.id,
          tx
        )
      ).toMatchObject({
        ok: true,
      });
      const asked = await questions(tx, t);
      expect(asked.destination).toEqual([]);
      expect(asked.source).toEqual([]);
      expect(asked.suppressed['in-transit']).toBe(0);
    });
  });
});
