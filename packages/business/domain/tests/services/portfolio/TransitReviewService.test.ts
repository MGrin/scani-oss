import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { TRANSFER_REVIEW_CREATED_SOURCE } from '@scani/shared';
import { and, eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { arrivalMetadata } from '../../../src/lib/created-destination';
import { sameHoldingGroupVerdict } from '../../../src/lib/upstream-event';
import { HoldingCacheWriter } from '../../../src/services/feeds/HoldingCacheWriter';
import { InTransitService } from '../../../src/services/portfolio/InTransitService';
import { TransitReviewService } from '../../../src/services/portfolio/TransitReviewService';
import { withTestDb } from '../../../test/helpers/db';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  seedReading,
} from '../../../test/helpers/factories-extra';
import { absorb, ago, travelling } from '../../../test/helpers/transit';

/**
 * Day 7 of a transfer in transit (SC-1675, #23729, rulings #23848): it stays
 * counted and Review asks. Arrived pairs the provider's inflow, a shortfall
 * booked as a fee; lost or a fee answers it so; came back pairs the refund on
 * the source; still waiting asks again 7 days later.
 */

const service = () => Container.get(TransitReviewService);
type Scenario = Awaited<ReturnType<typeof travelling>>;
const DAY = 24 * 60 * 60 * 1000;

/** The question about the part that went to `holdingId`, the scenario's destination by default. */
const keyOf = (t: Scenario, holdingId = t.destination.id) => ({
  outflowId: t.outflowId,
  destinationHoldingId: holdingId,
});

/** Sent 9 days ago; a provider reading the day after holds the destination without it. */
async function late(tx: DatabaseTransaction) {
  const t = await travelling(tx, { sentDaysAgo: 9 });
  await absorb(tx, t, ago(8));
  return t;
}

async function outflowOf(tx: DatabaseTransaction, t: Scenario) {
  const [row] = await tx
    .select()
    .from(schema.holdingTransactions)
    .where(eq(schema.holdingTransactions.id, t.outflowId));
  return row!;
}

async function legsOf(tx: DatabaseTransaction, holdingId: string) {
  return tx
    .select()
    .from(schema.holdingTransactions)
    .where(eq(schema.holdingTransactions.holdingId, holdingId));
}

async function balanceOf(tx: DatabaseTransaction, holdingId: string) {
  const [row] = await tx
    .select({ balance: schema.holdings.balance })
    .from(schema.holdings)
    .where(eq(schema.holdings.id, holdingId));
  return String(Number(row!.balance));
}

function providerInflow(tx: DatabaseTransaction, t: Scenario, quantity: string, at = ago(7)) {
  return makeHoldingTransaction(tx, {
    userId: t.userId,
    holdingId: t.destination.id,
    tokenId: t.baseId,
    kind: 'deposit',
    quantity,
    occurredAt: at,
    source: 'kraken',
    externalId: `k-${quantity}-${at.getTime()}`,
  });
}

function refund(tx: DatabaseTransaction, t: Scenario, quantity: string, at = ago(6)) {
  return makeHoldingTransaction(tx, {
    userId: t.userId,
    holdingId: t.source.id,
    tokenId: t.baseId,
    kind: 'deposit',
    quantity,
    occurredAt: at,
    source: 'wise',
    externalId: `w-${quantity}-${at.getTime()}`,
  });
}

async function stillTravelling(tx: DatabaseTransaction, t: Scenario) {
  return (await Container.get(InTransitService).amountsAt(t.userId, [new Date()], tx)).length;
}

describe('the day-7 question', () => {
  test('asks about a transfer travelling 7 days or more, never sooner', async () => {
    await withTestDb(async (tx) => {
      const t = await late(tx);
      const due = await service().listDue(t.userId, new Date(), tx);
      expect(due.map((q) => [q.outflowId, q.quantity])).toEqual([[t.outflowId, '500']]);
    });
    await withTestDb(async (tx) => {
      const t = await travelling(tx);
      await absorb(tx, t);
      expect(await stillTravelling(tx, t)).toBe(1);
      expect(await service().listDue(t.userId, new Date(), tx)).toEqual([]);
    });
  });

  test('still waiting keeps it counted and asks again 7 days later', async () => {
    await withTestDb(async (tx) => {
      const t = await late(tx);
      const now = new Date();
      expect(await service().stillWaiting(t.userId, keyOf(t), now, tx)).toMatchObject({
        ok: true,
      });
      expect(await service().listDue(t.userId, now, tx)).toEqual([]);
      expect(await stillTravelling(tx, t)).toBe(1);
      const later = new Date(now.getTime() + 8 * DAY);
      expect((await service().listDue(t.userId, later, tx)).length).toBe(1);
    });
  });

  test('offers the provider inflows on the destination and the refunds on the source', async () => {
    await withTestDb(async (tx) => {
      const t = await late(tx);
      const arrival = await providerInflow(tx, t, '500');
      const back = await refund(tx, t, '500');
      await providerInflow(tx, t, '600');
      await providerInflow(tx, t, '500', ago(12));
      const offered = await service().candidates(t.userId, keyOf(t), tx);
      expect({
        arrivals: offered.arrivals.map((r) => r.id),
        refunds: offered.refunds.map((r) => r.id),
      }).toEqual({ arrivals: [arrival.id], refunds: [back.id] });
    });
  });
});

describe('the answers', () => {
  test('arrived pairs the inflow and ends the transit', async () => {
    await withTestDb(async (tx) => {
      const t = await late(tx);
      const arrival = await providerInflow(tx, t, '500');
      expect(await service().arrived(t.userId, keyOf(t), arrival.id, tx)).toMatchObject({
        ok: true,
      });

      const outflow = await outflowOf(tx, t);
      const legs = await legsOf(tx, t.destination.id);
      expect({
        answer: outflow.transferReview,
        legs: legs.map((l) => [l.source, l.transferGroupId === outflow.transferGroupId]),
        balance: await balanceOf(tx, t.destination.id),
        travelling: await stillTravelling(tx, t),
        due: (await service().listDue(t.userId, new Date(), tx)).length,
      }).toEqual({
        answer: 'paired',
        legs: [['kraken', true]],
        balance: '1500',
        travelling: 0,
        due: 0,
      });
    });
  });

  test('arrived short books the rest as a fee', async () => {
    await withTestDb(async (tx) => {
      const t = await late(tx);
      const arrival = await providerInflow(tx, t, '480');
      expect(await service().arrived(t.userId, keyOf(t), arrival.id, tx)).toMatchObject({
        ok: true,
      });
      const outflow = await outflowOf(tx, t);
      expect({ answer: outflow.transferReview, split: outflow.transferReviewSplit }).toEqual({
        answer: 'split',
        split: [
          { decision: 'paired', quantity: '480', matchTransactionId: arrival.id },
          { decision: 'fee', quantity: '20' },
        ],
      });
    });
  });

  test('arrived refuses more than was sent, or an inflow before it left', async () => {
    await withTestDb(async (tx) => {
      const t = await late(tx);
      const more = await providerInflow(tx, t, '501');
      const before = await providerInflow(tx, t, '500', ago(12));
      expect(await service().arrived(t.userId, keyOf(t), more.id, tx)).toEqual({
        ok: false,
        reason: 'not_candidate',
      });
      expect(await service().arrived(t.userId, keyOf(t), before.id, tx)).toEqual({
        ok: false,
        reason: 'not_candidate',
      });
      expect((await outflowOf(tx, t)).transferReview).toBe('internal');
    });
  });

  test('lost or a fee answers the outflow so, and the money leaves', async () => {
    for (const decision of ['fee', 'left_control'] as const) {
      await withTestDb(async (tx) => {
        const t = await late(tx);
        expect(await service().lost(t.userId, keyOf(t), decision, tx)).toMatchObject({
          ok: true,
        });
        const outflow = await outflowOf(tx, t);
        expect({
          answer: outflow.transferReview,
          group: outflow.transferGroupId,
          legs: (await legsOf(tx, t.destination.id)).length,
          travelling: await stillTravelling(tx, t),
        }).toEqual({ answer: decision, group: null, legs: 0, travelling: 0 });
      });
    }
  });

  test('came back pairs the refund on the source and keeps the pair', async () => {
    await withTestDb(async (tx) => {
      const t = await late(tx);
      const back = await refund(tx, t, '500');
      expect(await service().cameBack(t.userId, keyOf(t), back.id, tx)).toMatchObject({
        ok: true,
      });

      const outflow = await outflowOf(tx, t);
      const sourceRows = await legsOf(tx, t.source.id);
      expect({
        answer: outflow.transferReview,
        paired: sourceRows.every((r) => r.transferGroupId === outflow.transferGroupId),
        group: outflow.transferGroupId !== null,
        destinationLegs: (await legsOf(tx, t.destination.id)).length,
        source: await balanceOf(tx, t.source.id),
        travelling: await stillTravelling(tx, t),
      }).toEqual({
        answer: 'paired',
        paired: true,
        group: true,
        destinationLegs: 0,
        source: '2000',
        travelling: 0,
      });
    });
  });

  test('came back refuses a refund of another amount', async () => {
    await withTestDb(async (tx) => {
      const t = await late(tx);
      const back = await refund(tx, t, '499');
      expect(await service().cameBack(t.userId, keyOf(t), back.id, tx)).toEqual({
        ok: false,
        reason: 'not_candidate',
      });
    });
  });

  test('an answer about a transfer that is not travelling is refused', async () => {
    await withTestDb(async (tx) => {
      const t = await late(tx);
      await service().lost(t.userId, keyOf(t), 'fee', tx);
      expect(await service().stillWaiting(t.userId, keyOf(t), new Date(), tx)).toEqual({
        ok: false,
        reason: 'gone',
      });
    });
  });
});

describe('a transfer that came back is a real round trip', () => {
  const legs = (returned: boolean) =>
    ['a', 'b'].map((key, i) => ({
      holdingId: 'h',
      source: 'wise',
      eventKey: key,
      ...(i === 0 ? { returned } : {}),
    }));

  test('the same-holding repair keeps it', () => {
    expect(sameHoldingGroupVerdict(legs(true)).unlink).toBe(false);
  });

  test('control: an unmarked pair of two events on one holding is still an artifact', () => {
    expect(sameHoldingGroupVerdict(legs(false)).unlink).toBe(true);
  });
});

/**
 * One withdrawal split across two provider-fed holdings (SC-1665): 500 to the
 * scenario's destination and 300 to a second account, both still travelling
 * after 9 days. Each part is its own question, and an answer rewrites that part
 * alone (SC-1684): reopening the outflow would put a second arrival beside a
 * part the provider already took over.
 */
async function twoDestinations(tx: DatabaseTransaction) {
  const t = await late(tx);
  const otherAccount = await makeAccount(tx, {
    userId: t.userId,
    institutionId: t.destinationAccount.institutionId,
  });
  const other = await makeHolding(tx, {
    userId: t.userId,
    accountId: otherAccount.id,
    tokenId: t.baseId,
    source: 'sync_exchange_balances',
    kind: 'feed',
  });
  await seedReading(tx, {
    userId: t.userId,
    holdingId: other.id,
    balance: '200',
    at: ago(10),
    authority: 'provider',
  });
  await seedReading(tx, {
    userId: t.userId,
    holdingId: other.id,
    balance: '200',
    at: ago(8),
    authority: 'provider',
  });
  const [outflow] = await tx
    .select({ occurredAt: schema.holdingTransactions.occurredAt })
    .from(schema.holdingTransactions)
    .where(eq(schema.holdingTransactions.id, t.outflowId));
  await tx
    .update(schema.holdingTransactions)
    .set({
      quantity: '-800',
      transferReview: 'split',
      transferReviewSplit: [
        {
          decision: 'internal',
          quantity: '500',
          destination: { accountId: t.destinationAccount.id, holdingId: t.destination.id },
        },
        {
          decision: 'internal',
          quantity: '300',
          destination: { accountId: otherAccount.id, holdingId: other.id },
        },
      ],
    })
    .where(eq(schema.holdingTransactions.id, t.outflowId));
  await makeHoldingTransaction(tx, {
    userId: t.userId,
    holdingId: other.id,
    tokenId: t.baseId,
    kind: 'transfer_in',
    quantity: '300',
    occurredAt: outflow!.occurredAt,
    source: TRANSFER_REVIEW_CREATED_SOURCE,
    externalId: t.outflowId,
    transferGroupId: t.groupId,
    inputId: null,
    sourceMetadata: arrivalMetadata({
      outflowTransactionId: t.outflowId,
      createdDestination: false,
      movedDestinationAnchor: false,
      outflowAt: outflow!.occurredAt,
    }),
  });
  await Container.get(HoldingCacheWriter).refresh(
    t.userId,
    [t.source.id, t.destination.id, other.id],
    tx
  );
  return { ...t, other };
}

type TwoDestinations = Awaited<ReturnType<typeof twoDestinations>>;

/** The 300 reached the second account at day 7 and its provider took the arrival over. */
async function takenOver(tx: DatabaseTransaction, t: TwoDestinations) {
  const ht = schema.holdingTransactions;
  await tx
    .update(ht)
    .set({ source: 'kraken', externalId: 'k-other-300', occurredAt: ago(7) })
    .where(and(eq(ht.holdingId, t.other.id), eq(ht.source, TRANSFER_REVIEW_CREATED_SOURCE)));
  await seedReading(tx, {
    userId: t.userId,
    holdingId: t.other.id,
    balance: '500',
    at: ago(6),
    authority: 'provider',
  });
  await Container.get(HoldingCacheWriter).refresh(t.userId, [t.other.id], tx);
}

async function legSources(tx: DatabaseTransaction, holdingId: string) {
  return (await legsOf(tx, holdingId)).map((l) => [l.source, l.transferGroupId]);
}

describe('a split that sent parts to several holdings (SC-1665 × SC-1684)', () => {
  test('Review asks once per destination, each about its own part', async () => {
    await withTestDb(async (tx) => {
      const t = await twoDestinations(tx);
      expect(await stillTravelling(tx, t)).toBe(2);
      const due = await service().listDue(t.userId, new Date(), tx);
      expect(
        due
          .map((q) => [q.outflowId, q.destinationHoldingId, q.quantity])
          .sort((a, b) => Number(b[2]) - Number(a[2]))
      ).toEqual([
        [t.outflowId, t.destination.id, '500'],
        [t.outflowId, t.other.id, '300'],
      ]);
    });
  });

  test('lost answers that part alone, and the part its provider took over keeps its row', async () => {
    await withTestDb(async (tx) => {
      const t = await twoDestinations(tx);
      await takenOver(tx, t);
      expect(await stillTravelling(tx, t)).toBe(1);
      expect(await service().lost(t.userId, keyOf(t), 'fee', tx)).toMatchObject({ ok: true });

      const outflow = await outflowOf(tx, t);
      expect({
        answer: outflow.transferReview,
        split: outflow.transferReviewSplit,
        group: outflow.transferGroupId,
        destination: await legSources(tx, t.destination.id),
        other: await legSources(tx, t.other.id),
        travelling: await stillTravelling(tx, t),
        due: (await service().listDue(t.userId, new Date(), tx)).length,
      }).toEqual({
        answer: 'split',
        split: [
          { decision: 'fee', quantity: '500' },
          {
            decision: 'internal',
            quantity: '300',
            destination: { accountId: t.other.accountId, holdingId: t.other.id },
          },
        ],
        group: t.groupId,
        destination: [],
        other: [['kraken', t.groupId]],
        travelling: 0,
        due: 0,
      });
    });
  });

  test("arrived takes the provider's inflow as that part's arrival, a shortfall a fee", async () => {
    await withTestDb(async (tx) => {
      const t = await twoDestinations(tx);
      await takenOver(tx, t);
      const arrival = await providerInflow(tx, t, '480');
      expect(await service().arrived(t.userId, keyOf(t), arrival.id, tx)).toMatchObject({
        ok: true,
      });

      const outflow = await outflowOf(tx, t);
      expect({
        split: outflow.transferReviewSplit,
        destination: await legSources(tx, t.destination.id),
        other: await legSources(tx, t.other.id),
        balance: await balanceOf(tx, t.destination.id),
        travelling: await stillTravelling(tx, t),
      }).toEqual({
        split: [
          {
            decision: 'internal',
            quantity: '480',
            destination: { accountId: t.destinationAccount.id, holdingId: t.destination.id },
          },
          {
            decision: 'internal',
            quantity: '300',
            destination: { accountId: t.other.accountId, holdingId: t.other.id },
          },
          { decision: 'fee', quantity: '20' },
        ],
        destination: [['kraken', t.groupId]],
        other: [['kraken', t.groupId]],
        balance: '1480',
        travelling: 0,
      });
    });
  });

  test('came back pairs the refund with that part alone', async () => {
    await withTestDb(async (tx) => {
      const t = await twoDestinations(tx);
      await takenOver(tx, t);
      const back = await refund(tx, t, '500');
      expect(await service().cameBack(t.userId, keyOf(t), back.id, tx)).toMatchObject({
        ok: true,
      });

      const outflow = await outflowOf(tx, t);
      const [refundRow] = await tx
        .select({ group: schema.holdingTransactions.transferGroupId })
        .from(schema.holdingTransactions)
        .where(eq(schema.holdingTransactions.id, back.id));
      expect({
        split: outflow.transferReviewSplit,
        refund: refundRow?.group,
        destination: await legSources(tx, t.destination.id),
        other: await legSources(tx, t.other.id),
        source: await balanceOf(tx, t.source.id),
        travelling: await stillTravelling(tx, t),
      }).toEqual({
        split: [
          { decision: 'paired', quantity: '500', matchTransactionId: back.id },
          {
            decision: 'internal',
            quantity: '300',
            destination: { accountId: t.other.accountId, holdingId: t.other.id },
          },
        ],
        refund: t.groupId,
        destination: [],
        other: [['kraken', t.groupId]],
        source: '1700',
        travelling: 0,
      });
    });
  });

  test('still waiting asks again about that part alone, 7 days later', async () => {
    await withTestDb(async (tx) => {
      const t = await twoDestinations(tx);
      const now = new Date();
      expect(await service().stillWaiting(t.userId, keyOf(t), now, tx)).toMatchObject({
        ok: true,
      });
      const asked = async (at: Date) =>
        (await service().listDue(t.userId, at, tx)).map((q) => q.destinationHoldingId).sort();
      expect(await asked(now)).toEqual([t.other.id]);
      expect(await asked(new Date(now.getTime() + 8 * DAY))).toEqual(
        [t.destination.id, t.other.id].sort()
      );
    });
  });

  test('CONTROL: an answer about one part leaves the other travelling', async () => {
    await withTestDb(async (tx) => {
      const t = await twoDestinations(tx);
      expect(await service().lost(t.userId, keyOf(t), 'left_control', tx)).toMatchObject({
        ok: true,
      });
      expect({
        travelling: await stillTravelling(tx, t),
        other: await legSources(tx, t.other.id),
        due: (await service().listDue(t.userId, new Date(), tx)).map((q) => q.destinationHoldingId),
      }).toEqual({
        travelling: 1,
        other: [[TRANSFER_REVIEW_CREATED_SOURCE, t.groupId]],
        due: [t.other.id],
      });
    });
  });

  test('an answer naming a holding the part did not go to is refused', async () => {
    await withTestDb(async (tx) => {
      const t = await twoDestinations(tx);
      expect(await service().lost(t.userId, keyOf(t, t.source.id), 'fee', tx)).toEqual({
        ok: false,
        reason: 'gone',
      });
      expect(await stillTravelling(tx, t)).toBe(2);
    });
  });
});
