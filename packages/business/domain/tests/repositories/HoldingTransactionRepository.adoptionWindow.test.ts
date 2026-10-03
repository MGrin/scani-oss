import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingTransactionRepository } from '../../src/repositories/HoldingTransactionRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeInstitutionType, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

/**
 * An imported arrival takes over the transfer-review row a person's answer wrote
 * for it. Several arrivals of the same amount on different days are different
 * money, so each must take over its own answer. Counting them as competitors for
 * one another left all three standing beside their answers (SC-1468).
 */

const repo = () => Container.get(HoldingTransactionRepository);
const DAYS = ['2025-11-07T10:00:00Z', '2025-11-15T10:00:00Z', '2025-11-21T10:00:00Z'];

async function wallet(tx: DatabaseTransaction) {
  const user = await makeUser(tx);
  const instType = await makeInstitutionType(tx);
  const inst = await makeInstitution(tx, { typeId: instType.id });
  const account = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
  const usdt = await makeToken(tx);
  const holding = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: usdt.id,
  });
  return { userId: user.id, tokenId: usdt.id, holdingId: holding.id };
}

function row(
  w: Awaited<ReturnType<typeof wallet>>,
  at: string,
  source: string,
  externalId: string
) {
  return {
    userId: w.userId,
    holdingId: w.holdingId,
    tokenId: w.tokenId,
    kind: 'transfer_in',
    quantity: '1000',
    occurredAt: new Date(at),
    source,
    externalId,
  };
}

async function rowsOf(tx: DatabaseTransaction, holdingId: string) {
  return tx
    .select()
    .from(schema.holdingTransactions)
    .where(eq(schema.holdingTransactions.holdingId, holdingId));
}

describe('bulkUpsert adoption compares only rows that could be the same arrival', () => {
  test('three equal arrivals on three days each take over their own review row', async () => {
    await withTestDb(async (tx) => {
      const w = await wallet(tx);
      await repo().bulkUpsert(
        DAYS.map((at, i) => row(w, at, 'transfer-review', `review-${i}`)),
        tx
      );
      await repo().bulkUpsert(
        DAYS.map((at, i) => row(w, at, 'etherscan', `0xhash${i}:in`)),
        tx
      );

      const rows = await rowsOf(tx, w.holdingId);
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.source === 'etherscan')).toBe(true);
    });
  });

  // A takeover rewrites the row's source and external id, which a re-import's
  // own change test does not compare, so the takeover moves `updated_at` itself.
  test('a takeover moves updated_at even when the re-import changes nothing else', async () => {
    await withTestDb(async (tx) => {
      const w = await wallet(tx);
      const longAgo = new Date('2025-01-01T00:00:00Z');
      const resent = row(w, DAYS[1]!, 'etherscan', '0xresent:in');
      await tx.insert(schema.holdingTransactions).values([
        { ...row(w, DAYS[0]!, 'transfer-review', 'review-0'), updatedAt: longAgo },
        { ...resent, updatedAt: longAgo },
      ]);

      await repo().bulkUpsert([row(w, DAYS[0]!, 'etherscan', '0xhash0:in'), resent], tx);

      const updatedAt = new Map(
        (await rowsOf(tx, w.holdingId)).map((r) => [`${r.source}/${r.externalId}`, r.updatedAt])
      );
      expect({
        takenOver: updatedAt.get('etherscan/0xhash0:in')! > longAgo,
        // The control: a row re-sent as it is held, with no takeover, keeps it.
        resent: updatedAt.get('etherscan/0xresent:in'),
        rows: updatedAt.size,
      }).toEqual({ takenOver: true, resent: longAgo, rows: 2 });
    });
  });

  test('control: two equal arrivals at the same instant still refuse to pick one', async () => {
    await withTestDb(async (tx) => {
      const w = await wallet(tx);
      await repo().bulkUpsert([row(w, DAYS[0]!, 'transfer-review', 'review-0')], tx);
      await repo().bulkUpsert(
        [row(w, DAYS[0]!, 'etherscan', '0xa:in'), row(w, DAYS[0]!, 'etherscan', '0xb:in')],
        tx
      );

      const rows = await rowsOf(tx, w.holdingId);
      expect(rows).toHaveLength(3);
      expect(rows.filter((r) => r.source === 'transfer-review')).toHaveLength(1);
    });
  });
});
