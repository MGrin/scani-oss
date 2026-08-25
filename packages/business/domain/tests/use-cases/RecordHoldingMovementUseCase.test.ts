/**
 * `RecordHoldingMovementUseCase` — the movement the owner knows, instead of
 * the balance they had to compute (SC-607).
 *
 * ## What these tests are for, and it is not the balance
 *
 * The balance moving is the easy half and a test asserting only that would
 * pass against a version of this feature that generates exactly the review
 * prompt it exists to remove. The ticket's own measure is a COUNT — *record a
 * 2000 USD withdrawal from a manual cash holding and count the review
 * prompts, target zero* — so the central test counts rows matching
 * `pendingPredicate`, which is the transfer-review queue's own definition of
 * "still to be asked about", imported rather than restated.
 *
 * A must-be-FOUND control sits beside it: the same withdrawal written the way
 * the balance editor writes it — a `flow` edit with no answer — puts exactly
 * one row in that queue. Without that control, "0 prompts" is equally
 * consistent with a predicate that matches nothing, and every assertion here
 * would be vacuous.
 */

import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { pendingPredicate } from '../../src/lib/transfer-review-queue';
import { MANUAL_EDIT_FLOW_SOURCE } from '../../src/services/holdings/ManualBalanceEditService';
import {
  MovementExceedsBalanceError,
  MovementSameHoldingError,
  RecordHoldingMovementUseCase,
} from '../../src/use-cases/RecordHoldingMovementUseCase';
import { UpdateHoldingUseCase } from '../../src/use-cases/UpdateHoldingUseCase';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

const useCase = () => Container.get(RecordHoldingMovementUseCase);

type Tx = Parameters<Parameters<typeof withTestDb>[0]>[0];

/** A manual cash holding at 4,000 — mgrin's reported shape. */
async function scaffold(tx: Tx) {
  const user = await makeUser(tx);
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  const token = await makeToken(tx, { symbol: `USD${Date.now()}` });
  const holding = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: token.id,
    balance: '4000',
    source: 'manual',
  });
  return { user, institution, account, token, holding };
}

/** How many rows the transfer-review queue would still ask about. */
async function reviewPrompts(tx: Tx, userId: string): Promise<number> {
  const rows = await tx
    .select({ id: schema.holdingTransactions.id })
    .from(schema.holdingTransactions)
    .where(pendingPredicate(userId));
  return rows.length;
}

async function ledger(tx: Tx, holdingId: string) {
  return await tx
    .select()
    .from(schema.holdingTransactions)
    .where(eq(schema.holdingTransactions.holdingId, holdingId));
}

async function balanceOf(tx: Tx, holdingId: string): Promise<string> {
  const [row] = await tx
    .select({ balance: schema.holdings.balance })
    .from(schema.holdings)
    .where(eq(schema.holdings.id, holdingId));
  if (!row) throw new Error('holding vanished');
  return row.balance;
}

const MOVED_AT = '2026-08-20T09:30:00.000Z';

describe('the ticket’s own measure: a 2000 withdrawal raises no prompt', () => {
  test('recording it as an outflow leaves the review queue empty', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);

      await useCase().execute(
        {
          direction: 'outflow',
          holdingId: holding.id,
          amount: '2000',
          occurredAt: MOVED_AT,
          destination: 'left_control',
        },
        user.id,
        tx
      );

      expect(await reviewPrompts(tx, user.id)).toBe(0);
      expect(await balanceOf(tx, holding.id)).toBe('2000');
    });
  });

  /**
   * The must-be-FOUND control. The identical withdrawal reached the way it
   * could be reached before this feature — set the balance to 2000 and say it
   * was a flow — leaves the queue holding one row.
   *
   * This is what makes the zero above a measurement. If `pendingPredicate`
   * ever stops matching (a column renamed, the import gone stale) this test
   * fails and the one above keeps passing while asserting nothing.
   */
  test('the same withdrawal as a bare balance edit leaves one', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);

      await Container.get(UpdateHoldingUseCase).execute(
        holding.id,
        { balance: '2000', editCause: 'flow', editOccurredAt: new Date(MOVED_AT) },
        user.id,
        tx
      );

      expect(await reviewPrompts(tx, user.id)).toBe(1);
    });
  });
});

describe('an outflow', () => {
  test('writes a dated withdraw carrying the owner’s answer', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);

      await useCase().execute(
        {
          direction: 'outflow',
          holdingId: holding.id,
          amount: '2000',
          occurredAt: MOVED_AT,
          destination: 'untracked',
        },
        user.id,
        tx
      );

      const rows = await ledger(tx, holding.id);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row?.kind).toBe('withdraw');
      expect(row?.source).toBe(MANUAL_EDIT_FLOW_SOURCE);
      // The date the OWNER gave, not the instant they typed it. Dating flows
      // at the edit instant is what `e1fa63e5` removed.
      expect(row?.occurredAt.toISOString()).toBe(MOVED_AT);
      expect(row?.transferReview).toBe('untracked');
      expect(row?.transferReviewSource).toBe('user');
    });
  });

  test('refuses to take more than the holding holds', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);
      await expect(
        useCase().execute(
          {
            direction: 'outflow',
            holdingId: holding.id,
            amount: '4000.01',
            occurredAt: MOVED_AT,
            destination: 'left_control',
          },
          user.id,
          tx
        )
      ).rejects.toBeInstanceOf(MovementExceedsBalanceError);
    });
  });
});

describe('an inflow', () => {
  test('raises the balance and books a deposit nobody is asked about', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);

      await useCase().execute(
        { direction: 'inflow', holdingId: holding.id, amount: '250.5', occurredAt: MOVED_AT },
        user.id,
        tx
      );

      expect(await balanceOf(tx, holding.id)).toBe('4250.5');
      const [row] = await ledger(tx, holding.id);
      expect(row?.kind).toBe('deposit');
      // `answerIsOwedFor` covers withdraw and transfer_out only, so an
      // arrival is never a queue row whatever it carries.
      expect(await reviewPrompts(tx, user.id)).toBe(0);
    });
  });
});

describe('a declared transfer', () => {
  test('moves both balances and links the legs as one pair', async () => {
    await withTestDb(async (tx) => {
      const { user, institution, token, holding } = await scaffold(tx);
      const other = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const destination = await makeHolding(tx, {
        userId: user.id,
        accountId: other.id,
        tokenId: token.id,
        balance: '10',
        source: 'manual',
      });

      const result = await useCase().execute(
        {
          direction: 'transfer',
          holdingId: holding.id,
          amount: '2000',
          occurredAt: MOVED_AT,
          destinationAccountId: other.id,
          destinationHoldingId: destination.id,
        },
        user.id,
        tx
      );

      expect(await balanceOf(tx, holding.id)).toBe('2000');
      // The half this cannot get from `writeInflow`, which inserts the arrival
      // row and leaves an existing destination's balance untouched.
      expect(await balanceOf(tx, destination.id)).toBe('2010');

      const [out] = await ledger(tx, holding.id);
      const [arrival] = await ledger(tx, destination.id);
      expect(out?.kind).toBe('withdraw');
      expect(arrival?.kind).toBe('deposit');
      expect(out?.transferGroupId).toBe(result.transferGroupId);
      expect(arrival?.transferGroupId).toBe(result.transferGroupId);
      expect(result.transferGroupId).not.toBeNull();

      // A paired outflow is out of the queue on the group id alone — the
      // reason a transfer needs no `transfer_review` answer from the owner.
      expect(await reviewPrompts(tx, user.id)).toBe(0);
    });
  });

  test('creates the destination holding when the account holds none', async () => {
    await withTestDb(async (tx) => {
      const { user, institution, token, holding } = await scaffold(tx);
      const fresh = await makeAccount(tx, { userId: user.id, institutionId: institution.id });

      const result = await useCase().execute(
        {
          direction: 'transfer',
          holdingId: holding.id,
          amount: '2000',
          occurredAt: MOVED_AT,
          destinationAccountId: fresh.id,
        },
        user.id,
        tx
      );

      expect(result.destinationHoldingId).not.toBeNull();
      const created = result.destinationHoldingId;
      if (!created) throw new Error('no destination');
      // Opened at zero and then moved by the ordinary flow, so the arrival is
      // a ledger row rather than an opening figure with nothing explaining it.
      expect(await balanceOf(tx, created)).toBe('2000');
      const [arrival] = await ledger(tx, created);
      expect(arrival?.kind).toBe('deposit');
      expect(arrival?.quantity).toBe('2000');

      const [row] = await tx
        .select({ tokenId: schema.holdings.tokenId, accountId: schema.holdings.accountId })
        .from(schema.holdings)
        .where(eq(schema.holdings.id, created));
      expect(row?.tokenId).toBe(token.id);
      expect(row?.accountId).toBe(fresh.id);
      expect(await reviewPrompts(tx, user.id)).toBe(0);
    });
  });

  test('refuses to send a holding to itself', async () => {
    await withTestDb(async (tx) => {
      const { user, account, holding } = await scaffold(tx);
      await expect(
        useCase().execute(
          {
            direction: 'transfer',
            holdingId: holding.id,
            amount: '10',
            occurredAt: MOVED_AT,
            destinationAccountId: account.id,
            destinationHoldingId: holding.id,
          },
          user.id,
          tx
        )
      ).rejects.toBeInstanceOf(MovementSameHoldingError);
    });
  });
});

describe('ownership', () => {
  test('another user’s holding reads as absent, not as a balance', async () => {
    await withTestDb(async (tx) => {
      const { holding } = await scaffold(tx);
      const stranger = await makeUser(tx);
      await expect(
        useCase().execute(
          { direction: 'inflow', holdingId: holding.id, amount: '1', occurredAt: MOVED_AT },
          stranger.id,
          tx
        )
      ).rejects.toThrow();
    });
  });
});
