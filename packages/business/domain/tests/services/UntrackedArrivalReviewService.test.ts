import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { UntrackedArrivalReviewService } from '../../src/services/UntrackedArrivalReviewService';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
} from '../../test/helpers/factories-extra';

/**
 * SC-1696. An outflow the owner answered `untracked` ("an account Scani can't
 * see") is never revisited by the matcher, by design. When its arrival later
 * shows up in an account Scani does see, Review asks once: "Was this the
 * transfer to <account>?" Asking does not overrule the answer; only a yes
 * changes it.
 *
 * The shape is the case that found it: 500 USD left Wise by a balance edit
 * answered `untracked`, and IBKR's import brought the 500 USD deposit a day
 * and a half later.
 */

const service = () => Container.get(UntrackedArrivalReviewService);
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const ago = (days: number) => new Date(NOW - days * DAY);

async function wiseToIbkr(tx: DatabaseTransaction, opts: { untracked?: string | null } = {}) {
  const cash = await makeToken(tx);
  const user = await makeUser(tx, { baseCurrencyId: cash.id });
  const institutionId = (await makeInstitution(tx)).id;
  const wise = await makeAccount(tx, { userId: user.id, institutionId, name: 'Wise Savings' });
  const ibkr = await makeAccount(tx, { userId: user.id, institutionId, name: 'IBKR Portfolio' });
  const source = await makeHolding(tx, { userId: user.id, accountId: wise.id, tokenId: cash.id });
  const destination = await makeHolding(tx, {
    userId: user.id,
    accountId: ibkr.id,
    tokenId: cash.id,
  });
  const outflow = await makeHoldingTransaction(tx, {
    userId: user.id,
    holdingId: source.id,
    tokenId: cash.id,
    kind: 'withdraw',
    quantity: '-500',
    occurredAt: ago(3),
    source: 'user-balance-edit',
    externalId: `manual-edit:${ago(3).toISOString()}`,
    transferReview: opts.untracked === undefined ? 'untracked' : opts.untracked,
    transferReviewSource: opts.untracked === null ? null : 'user',
  });
  const deposit = (quantity: string, at: Date, holdingId = destination.id, tokenId = cash.id) =>
    makeHoldingTransaction(tx, {
      userId: user.id,
      holdingId,
      tokenId,
      kind: 'deposit',
      quantity,
      occurredAt: at,
      source: 'ibkr-api',
      externalId: `ibkr-${quantity}-${at.getTime()}-${Math.random()}`,
    });
  return { userId: user.id, cash, wise, ibkr, source, destination, outflow, deposit };
}

async function rowOf(tx: DatabaseTransaction, id: string) {
  const [row] = await tx
    .select()
    .from(schema.holdingTransactions)
    .where(eq(schema.holdingTransactions.id, id));
  return row!;
}

describe('an untracked outflow whose arrival shows up later (SC-1696)', () => {
  test('asks once, naming the account the money arrived in', async () => {
    await withTestDb(async (tx) => {
      const t = await wiseToIbkr(tx);
      const arrival = await t.deposit('500', ago(1.5));
      const due = await service().listDue(t.userId, tx);
      expect(
        due.map((q) => ({
          outflowId: q.outflowId,
          inflowId: q.inflowId,
          quantity: q.quantity,
          tokenSymbol: q.tokenSymbol,
          sourceAccountName: q.sourceAccountName,
          destinationAccountName: q.destinationAccountName,
        }))
      ).toEqual([
        {
          outflowId: t.outflow.id,
          inflowId: arrival.id,
          quantity: '500',
          tokenSymbol: t.cash.symbol,
          sourceAccountName: 'Wise Savings',
          destinationAccountName: 'IBKR Portfolio',
        },
      ]);
    });
  });

  test('a fee of up to 1% still asks; anything further apart does not', async () => {
    await withTestDb(async (tx) => {
      const t = await wiseToIbkr(tx);
      await t.deposit('495.5', ago(2));
      expect((await service().listDue(t.userId, tx)).length).toBe(1);
    });
    await withTestDb(async (tx) => {
      const t = await wiseToIbkr(tx);
      await t.deposit('480', ago(2));
      expect(await service().listDue(t.userId, tx)).toEqual([]);
    });
  });

  test('an arrival up to 7 days after it asks; one later, or dated before it, does not', async () => {
    await withTestDb(async (tx) => {
      const t = await wiseToIbkr(tx);
      await t.deposit('500', new Date(t.outflow.occurredAt.getTime() + 6.5 * DAY));
      expect((await service().listDue(t.userId, tx)).length).toBe(1);
    });
    await withTestDb(async (tx) => {
      const t = await wiseToIbkr(tx);
      await t.deposit('500', new Date(t.outflow.occurredAt.getTime() + 7.5 * DAY));
      expect(await service().listDue(t.userId, tx)).toEqual([]);
    });
    await withTestDb(async (tx) => {
      const t = await wiseToIbkr(tx);
      await t.deposit('500', new Date(t.outflow.occurredAt.getTime() - 0.5 * DAY));
      expect(await service().listDue(t.userId, tx)).toEqual([]);
    });
  });

  test('another token or the same holding: no question', async () => {
    await withTestDb(async (tx) => {
      const t = await wiseToIbkr(tx);
      const other = await makeToken(tx);
      const elsewhere = await makeHolding(tx, {
        userId: t.userId,
        accountId: t.ibkr.id,
        tokenId: other.id,
      });
      await t.deposit('500', ago(2), elsewhere.id, other.id);
      expect(await service().listDue(t.userId, tx)).toEqual([]);
    });
    await withTestDb(async (tx) => {
      const t = await wiseToIbkr(tx);
      await t.deposit('500', ago(2), t.source.id);
      expect(await service().listDue(t.userId, tx)).toEqual([]);
    });
  });

  test('two arrivals that fit is not one question: it asks nothing', async () => {
    await withTestDb(async (tx) => {
      const t = await wiseToIbkr(tx);
      await t.deposit('500', ago(2));
      await t.deposit('500', ago(1));
      expect(await service().listDue(t.userId, tx)).toEqual([]);
    });
  });

  test('only an `untracked` answer is revisited: unanswered and left_control are not', async () => {
    await withTestDb(async (tx) => {
      const t = await wiseToIbkr(tx, { untracked: 'left_control' });
      await t.deposit('500', ago(2));
      expect(await service().listDue(t.userId, tx)).toEqual([]);
    });
    await withTestDb(async (tx) => {
      const t = await wiseToIbkr(tx, { untracked: null });
      await t.deposit('500', ago(2));
      expect(await service().listDue(t.userId, tx)).toEqual([]);
    });
  });

  test('yes pairs the two legs, and the question is gone', async () => {
    await withTestDb(async (tx) => {
      const t = await wiseToIbkr(tx);
      const arrival = await t.deposit('500', ago(1.5));
      const result = await service().confirm(
        t.userId,
        { outflowId: t.outflow.id, inflowId: arrival.id },
        tx
      );
      expect(result).toMatchObject({ ok: true });
      const out = await rowOf(tx, t.outflow.id);
      const inn = await rowOf(tx, arrival.id);
      expect(out.transferReview).toBe('paired');
      expect(out.transferGroupId).not.toBeNull();
      expect(inn.transferGroupId).toBe(out.transferGroupId);
      expect(await service().listDue(t.userId, tx)).toEqual([]);
    });
  });

  test('no keeps the untracked answer and never asks about that pair again', async () => {
    await withTestDb(async (tx) => {
      const t = await wiseToIbkr(tx);
      const arrival = await t.deposit('500', ago(1.5));
      const result = await service().decline(
        t.userId,
        { outflowId: t.outflow.id, inflowId: arrival.id },
        tx
      );
      expect(result).toMatchObject({ ok: true });
      const out = await rowOf(tx, t.outflow.id);
      expect(out.transferReview).toBe('untracked');
      expect(out.transferGroupId).toBeNull();
      expect(await service().listDue(t.userId, tx)).toEqual([]);
    });
  });

  test('an answer to a pair that is no longer asked is refused, and changes nothing', async () => {
    await withTestDb(async (tx) => {
      const t = await wiseToIbkr(tx);
      const arrival = await t.deposit('500', ago(1.5));
      await t.deposit('500', ago(1));
      const result = await service().confirm(
        t.userId,
        { outflowId: t.outflow.id, inflowId: arrival.id },
        tx
      );
      expect(result).toEqual({ ok: false, reason: 'gone' });
      expect((await rowOf(tx, t.outflow.id)).transferReview).toBe('untracked');
    });
  });
});
