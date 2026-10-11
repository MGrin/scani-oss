import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { TRANSFER_REVIEW_CREATED_SOURCE } from '@scani/shared';
import Decimal from 'decimal.js';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { InTransitService } from '../../../src/services/portfolio/InTransitService';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
  seedReading,
} from '../../../test/helpers/factories-extra';

/**
 * Which transfers are travelling, read from the database the way
 * `TransferReviewService.writeInflow` leaves an `internal` answer (SC-1675):
 * the outflow answered, a group, and a person's arrival leg in a
 * provider-fed holding dated at the outflow.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const ago = (days: number) => new Date(NOW - days * DAY);

async function scenario(tx: DatabaseTransaction, destinationKind: 'feed' | 'snapshot' = 'feed') {
  const user = await makeUser(tx);
  const institutionId = (await makeInstitution(tx)).id;
  const token = await makeToken(tx);
  const source = await makeHolding(tx, {
    userId: user.id,
    accountId: (await makeAccount(tx, { userId: user.id, institutionId })).id,
    tokenId: token.id,
    source: 'manual',
    kind: 'snapshot',
  });
  await seedReading(tx, { userId: user.id, holdingId: source.id, balance: '2000', at: ago(10) });
  const destination = await makeHolding(tx, {
    userId: user.id,
    accountId: (await makeAccount(tx, { userId: user.id, institutionId })).id,
    tokenId: token.id,
    source: 'sync_exchange_balances',
    kind: destinationKind,
  });
  await seedReading(tx, {
    userId: user.id,
    holdingId: destination.id,
    balance: '1000',
    at: ago(10),
    authority: destinationKind === 'feed' ? 'provider' : 'person',
  });
  return { userId: user.id, tokenId: token.id, source, destination };
}

type Scenario = Awaited<ReturnType<typeof scenario>>;

async function sendInternal(
  tx: DatabaseTransaction,
  s: Scenario,
  answer: { review?: string; split?: unknown; arrival?: string } = {}
) {
  const groupId = randomUUID();
  const outflow = await makeHoldingTransaction(tx, {
    userId: s.userId,
    holdingId: s.source.id,
    kind: 'withdraw',
    quantity: '-500',
    occurredAt: ago(5),
    transferReview: answer.review ?? 'internal',
    transferReviewSource: 'user',
    transferReviewedAt: ago(4),
    transferReviewSplit: answer.split ?? null,
    transferGroupId: groupId,
  });
  const arrival = await makeHoldingTransaction(tx, {
    userId: s.userId,
    holdingId: s.destination.id,
    kind: 'transfer_in',
    quantity: answer.arrival ?? '500',
    occurredAt: ago(5),
    source: TRANSFER_REVIEW_CREATED_SOURCE,
    externalId: outflow.id,
    transferGroupId: groupId,
    inputId: null,
  });
  return { outflow, arrival, groupId };
}

const service = () => Container.get(InTransitService);

describe('InTransitService.openTransits', () => {
  test('an outflow answered internal to a provider-fed holding is travelling', async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      const { outflow, arrival } = await sendInternal(tx, s);
      const open = await service().openTransits(s.userId, tx);
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({
        outflowId: outflow.id,
        sourceHoldingId: s.source.id,
        destinationHoldingId: s.destination.id,
        tokenId: s.tokenId,
        transit: { sent: '500', arrivalId: arrival.id, arrived: false },
      });
    });
  });

  test('a snapshot destination moves its balance instead, so nothing travels', async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx, 'snapshot');
      await sendInternal(tx, s);
      expect(await service().openTransits(s.userId, tx)).toEqual([]);
    });
  });

  test('a destination on a liability account carries no transit (SC-1664 × SC-1675)', async () => {
    // A debt holding's value is taken back out of P&L once as debtValue, so
    // money travelling into one would count twice (#24146). It moves the
    // debt when it lands, and until then nothing is held in transit for it.
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      await sendInternal(tx, s);
      const [card] = await tx
        .select({ id: schema.accountTypes.id, class: schema.accountTypes.class })
        .from(schema.accountTypes)
        .where(eq(schema.accountTypes.code, 'credit_card'));
      expect(card?.class).toBe('liability');
      await tx
        .update(schema.accounts)
        .set({ typeId: card!.id })
        .where(eq(schema.accounts.id, s.destination.accountId));
      expect(await service().openTransits(s.userId, tx)).toEqual([]);
      expect(await service().amountsAt(s.userId, [new Date()], tx)).toEqual([]);
    });
  });

  test('an outflow answered as a fee is not travelling', async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      await sendInternal(tx, s, { review: 'fee' });
      expect(await service().openTransits(s.userId, tx)).toEqual([]);
    });
  });

  test("a split's internal portion travels as that portion", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      const { arrival } = await sendInternal(tx, s, {
        review: 'split',
        arrival: '300',
        split: [
          {
            decision: 'internal',
            quantity: '300',
            destination: { accountId: s.destination.accountId, holdingId: s.destination.id },
          },
          { decision: 'fee', quantity: '200' },
        ],
      });
      const open = await service().openTransits(s.userId, tx);
      expect(open).toHaveLength(1);
      expect(open[0]?.transit).toMatchObject({ sent: '300', arrivalId: arrival.id });
    });
  });

  test("another user's transit is not this user's", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      await sendInternal(tx, s);
      const other = await makeUser(tx);
      expect(await service().openTransits(other.id, tx)).toEqual([]);
    });
  });
});

describe('InTransitService.amountsAt', () => {
  test('0 until a provider reading anchors without it, then all of it', async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      const { outflow } = await sendInternal(tx, s);
      expect(await service().amountsAt(s.userId, [ago(4)], tx)).toEqual([]);
      await seedReading(tx, {
        userId: s.userId,
        holdingId: s.destination.id,
        balance: '1000',
        at: ago(3),
        authority: 'provider',
      });
      const amounts = await service().amountsAt(s.userId, [ago(4), ago(2)], tx);
      expect(amounts).toHaveLength(1);
      expect(amounts[0]).toMatchObject({ outflowId: outflow.id, tokenId: s.tokenId });
      expect(amounts[0]?.at).toEqual(ago(2));
      expect(amounts[0]?.quantity.toFixed()).toBe('500');
    });
  });

  test("once the provider's row is the arrival, it travelled until that row's date", async () => {
    await withTestDb(async (tx) => {
      const s = await scenario(tx);
      const { arrival } = await sendInternal(tx, s);
      await tx
        .update(schema.holdingTransactions)
        .set({ source: 'exchange-sync', occurredAt: ago(3), kind: 'deposit' })
        .where(eq(schema.holdingTransactions.id, arrival.id));
      const amounts = await service().amountsAt(s.userId, [ago(4), ago(2)], tx);
      expect(amounts.map((a) => [a.at.getTime(), a.quantity.toFixed()])).toEqual([
        [ago(4).getTime(), '500'],
      ]);
      // Returns moves this arrival's inflow back to the outflow, so it needs the
      // leg as it stands: landed, with the provider's quantity and date.
      const [open] = await service().openTransits(s.userId, tx);
      expect(open?.transit.arrived).toBe(true);
      expect(open?.arrival.at.getTime()).toBe(ago(3).getTime());
      expect(new Decimal(open?.arrival.quantity ?? '0').toFixed()).toBe('500');
    });
  });
});
