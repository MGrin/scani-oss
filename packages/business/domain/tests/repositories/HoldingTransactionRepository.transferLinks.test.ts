import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Container } from 'typedi';
import { HoldingTransactionRepository } from '../../src/repositories/HoldingTransactionRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeInstitutionType, makeUser } from '../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
} from '../../test/helpers/factories-extra';

/**
 * `findTransferLinkedHoldingIds` (SC-152), against a real database.
 *
 * It is the one piece of the realized ledger that is raw SQL rather than
 * arithmetic, and the property it has to hold — transitive closure over shared
 * `transfer_group_id`s — is exactly the kind a single join silently gets wrong:
 * A pairs with B, B pairs with C, and C's acquisitions are still part of the
 * answer to a question about A. A ledger built on a short expansion would
 * report a disposal with no acquisition and grade it `unknown`, which reads as
 * a data problem rather than as our own missing join.
 */

const repo = () => Container.get(HoldingTransactionRepository);

async function makeUserWithHoldings(
  tx: Parameters<typeof makeUser>[0],
  count: number
): Promise<{ userId: string; holdingIds: string[] }> {
  const user = await makeUser(tx);
  const instType = await makeInstitutionType(tx);
  const inst = await makeInstitution(tx, { typeId: instType.id });
  const token = await makeToken(tx);
  const holdingIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const account = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
    const holding = await makeHolding(tx, {
      userId: user.id,
      accountId: account.id,
      tokenId: token.id,
    });
    holdingIds.push(holding.id);
  }
  return { userId: user.id, holdingIds };
}

describe('HoldingTransactionRepository.findTransferLinkedHoldingIds', () => {
  test('a holding with no transfers is its own component', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingIds } = await makeUserWithHoldings(tx, 2);
      const [a] = holdingIds as [string, string];
      await makeHoldingTransaction(tx, { userId, holdingId: a, kind: 'buy', quantity: '1' });

      // The common case, and the one the cost argument rests on: answering
      // about this holding must not read the rest of the portfolio.
      expect(await repo().findTransferLinkedHoldingIds(userId, [a], tx)).toEqual([a]);
    });
  });

  test('follows a shared transfer_group_id in both directions', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingIds } = await makeUserWithHoldings(tx, 2);
      const [a, b] = holdingIds as [string, string];
      const group1 = randomUUID();
      await makeHoldingTransaction(tx, {
        userId,
        holdingId: a,
        kind: 'transfer_out',
        quantity: '-1',
        transferGroupId: group1,
      });
      await makeHoldingTransaction(tx, {
        userId,
        holdingId: b,
        kind: 'transfer_in',
        quantity: '1',
        transferGroupId: group1,
      });

      expect((await repo().findTransferLinkedHoldingIds(userId, [a], tx)).sort()).toEqual(
        [a, b].sort()
      );
      // Asked from the other end, the same component. The lots moved one way;
      // the question about basis travels both.
      expect((await repo().findTransferLinkedHoldingIds(userId, [b], tx)).sort()).toEqual(
        [a, b].sort()
      );
    });
  });

  test('closes transitively: A→B and B→C reach C from A', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingIds } = await makeUserWithHoldings(tx, 4);
      const [a, b, c, unrelated] = holdingIds as [string, string, string, string];
      for (const [from, to, group] of [
        [a, b, randomUUID()],
        [b, c, randomUUID()],
      ] as const) {
        await makeHoldingTransaction(tx, {
          userId,
          holdingId: from,
          kind: 'transfer_out',
          quantity: '-1',
          transferGroupId: group,
        });
        await makeHoldingTransaction(tx, {
          userId,
          holdingId: to,
          kind: 'transfer_in',
          quantity: '1',
          transferGroupId: group,
        });
      }
      await makeHoldingTransaction(tx, {
        userId,
        holdingId: unrelated,
        kind: 'buy',
        quantity: '1',
      });

      const reached = await repo().findTransferLinkedHoldingIds(userId, [a], tx);
      expect(reached.sort()).toEqual([a, b, c].sort());
      // The fixpoint is bounded by the relation, not by the portfolio: a
      // holding nothing connects to stays out.
      expect(reached).not.toContain(unrelated);
    });
  });

  test('never crosses a user boundary', async () => {
    await withTestDb(async (tx) => {
      const mine = await makeUserWithHoldings(tx, 1);
      const theirs = await makeUserWithHoldings(tx, 1);
      const [a] = mine.holdingIds as [string];
      const [other] = theirs.holdingIds as [string];
      const shared = randomUUID();
      // The same group id on two users' rows. Group ids are minted per user,
      // so this cannot arise — which is exactly why the guard has to be
      // asserted rather than assumed.
      for (const [userId, holdingId] of [
        [mine.userId, a],
        [theirs.userId, other],
      ] as const) {
        await makeHoldingTransaction(tx, {
          userId,
          holdingId,
          kind: 'transfer_out',
          quantity: '-1',
          transferGroupId: shared,
        });
      }

      expect(await repo().findTransferLinkedHoldingIds(mine.userId, [a], tx)).toEqual([a]);
    });
  });

  test('an empty seed reads nothing', async () => {
    await withTestDb(async (tx) => {
      const { userId } = await makeUserWithHoldings(tx, 1);
      expect(await repo().findTransferLinkedHoldingIds(userId, [], tx)).toEqual([]);
    });
  });
});
