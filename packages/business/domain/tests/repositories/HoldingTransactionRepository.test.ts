import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { HoldingTransactionRepository } from '../../src/repositories/HoldingTransactionRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeInstitutionType, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

const repo = () => Container.get(HoldingTransactionRepository);

/**
 * Helper to spin up a fresh (user, institution, account, token, holding)
 * tuple inside a test transaction. Returns the holding id since most
 * tests just need that anchor.
 */
async function makeHoldingFixture(tx: Parameters<typeof makeUser>[0]): Promise<{
  userId: string;
  accountId: string;
  tokenId: string;
  holdingId: string;
}> {
  const user = await makeUser(tx);
  const instType = await makeInstitutionType(tx);
  const inst = await makeInstitution(tx, { typeId: instType.id });
  const acct = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
  const tok = await makeToken(tx);
  const holding = await makeHolding(tx, {
    userId: user.id,
    accountId: acct.id,
    tokenId: tok.id,
  });
  return { userId: user.id, accountId: acct.id, tokenId: tok.id, holdingId: holding.id };
}

describe('HoldingTransactionRepository', () => {
  test('bulkUpsert inserts new rows and short-circuits when given an empty array', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId, tokenId } = await makeHoldingFixture(tx);
      const empty = await repo().bulkUpsert([], tx);
      expect(empty).toEqual([]);

      const inserted = await repo().bulkUpsert(
        [
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '1.5',
            occurredAt: new Date('2024-06-01T00:00:00Z'),
            source: 'kraken-api',
            externalId: 'k-1',
          },
        ],
        tx
      );
      expect(inserted).toHaveLength(1);
      expect(inserted[0]?.holdingId).toBe(holdingId);
      expect(inserted[0]?.quantity).toBe('1.5');
    });
  });

  test('bulkUpsert is idempotent on (holding_id, source, external_id) and overwrites the quantity', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId, tokenId } = await makeHoldingFixture(tx);
      const first = await repo().bulkUpsert(
        [
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '1.0',
            occurredAt: new Date('2024-06-01T00:00:00Z'),
            source: 'kraken-api',
            externalId: 'k-1',
          },
        ],
        tx
      );
      // Re-ingest same external_id with a different normalized quantity —
      // the row must survive (no duplicate) but reflect the new value.
      const second = await repo().bulkUpsert(
        [
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '2.0',
            occurredAt: new Date('2024-06-01T00:00:00Z'),
            source: 'kraken-api',
            externalId: 'k-1',
          },
        ],
        tx
      );
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      // Same id — UPSERT.
      expect(second[0]?.id).toBe(first[0]?.id ?? '');
      expect(second[0]?.quantity).toBe('2.0');
    });
  });

  test('findForHoldingInRange returns only txs strictly after `from` and at-or-before `to`, ordered by occurredAt', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId, tokenId } = await makeHoldingFixture(tx);
      const before = new Date('2024-01-01T00:00:00Z');
      const inside = new Date('2024-06-15T00:00:00Z');
      const inside2 = new Date('2024-06-20T00:00:00Z');
      const after = new Date('2025-01-01T00:00:00Z');
      await repo().bulkUpsert(
        [
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '1',
            occurredAt: before,
            source: 's',
            externalId: 'a',
          },
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '2',
            occurredAt: inside2,
            source: 's',
            externalId: 'b',
          },
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '3',
            occurredAt: inside,
            source: 's',
            externalId: 'c',
          },
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '4',
            occurredAt: after,
            source: 's',
            externalId: 'd',
          },
        ],
        tx
      );
      const rows = await repo().findForHoldingInRange(
        holdingId,
        new Date('2024-06-01T00:00:00Z'),
        new Date('2024-12-31T23:59:59Z'),
        tx
      );
      // Excludes `before` (before from) and `after` (after to).
      expect(rows.map((r) => r.externalId)).toEqual(['c', 'b']);
    });
  });

  test('sumQuantityInRange aggregates signed quantities in (from, to]', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId, tokenId } = await makeHoldingFixture(tx);
      const t1 = new Date('2024-06-15T00:00:00Z');
      const t2 = new Date('2024-06-20T00:00:00Z');
      await repo().bulkUpsert(
        [
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '5',
            occurredAt: t1,
            source: 's',
            externalId: 'a',
          },
          {
            userId,
            holdingId,
            tokenId,
            kind: 'withdraw',
            quantity: '-2',
            occurredAt: t2,
            source: 's',
            externalId: 'b',
          },
        ],
        tx
      );
      const sum = await repo().sumQuantityInRange(
        holdingId,
        new Date('2024-06-01T00:00:00Z'),
        new Date('2024-12-31T23:59:59Z'),
        tx
      );
      expect(sum).toBe('3');
    });
  });

  test('findExtremesForHolding returns null/null when the holding has no transactions', async () => {
    await withTestDb(async (tx) => {
      const { holdingId } = await makeHoldingFixture(tx);
      const e = await repo().findExtremesForHolding(holdingId, tx);
      expect(e.first).toBeNull();
      expect(e.last).toBeNull();
    });
  });

  test('findExtremesForHolding returns earliest and latest occurredAt across multiple txs', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId, tokenId } = await makeHoldingFixture(tx);
      const tEarly = new Date('2023-03-01T00:00:00Z');
      const tMid = new Date('2024-06-15T00:00:00Z');
      const tLate = new Date('2025-09-30T00:00:00Z');
      await repo().bulkUpsert(
        [
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '1',
            occurredAt: tMid,
            source: 's',
            externalId: 'a',
          },
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '1',
            occurredAt: tLate,
            source: 's',
            externalId: 'b',
          },
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '1',
            occurredAt: tEarly,
            source: 's',
            externalId: 'c',
          },
        ],
        tx
      );
      const e = await repo().findExtremesForHolding(holdingId, tx);
      expect(e.first?.getTime()).toBe(tEarly.getTime());
      expect(e.last?.getTime()).toBe(tLate.getTime());
    });
  });

  test('sumQuantityForHoldingUntil includes everything up to the cutoff (inclusive)', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId, tokenId } = await makeHoldingFixture(tx);
      await repo().bulkUpsert(
        [
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '10',
            occurredAt: new Date('2024-01-01T00:00:00Z'),
            source: 's',
            externalId: 'a',
          },
          {
            userId,
            holdingId,
            tokenId,
            kind: 'withdraw',
            quantity: '-3',
            occurredAt: new Date('2024-06-01T00:00:00Z'),
            source: 's',
            externalId: 'b',
          },
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '5',
            occurredAt: new Date('2025-01-01T00:00:00Z'),
            source: 's',
            externalId: 'c',
          },
        ],
        tx
      );
      const sumMid = await repo().sumQuantityForHoldingUntil(
        holdingId,
        new Date('2024-12-31T23:59:59Z'),
        tx
      );
      // Includes the +10 and the -3 but excludes the +5.
      expect(sumMid).toBe('7');
      const sumAll = await repo().sumQuantityForHoldingUntil(
        holdingId,
        new Date('9999-12-31T23:59:59Z'),
        tx
      );
      expect(sumAll).toBe('12');
    });
  });

  test('deleteForHoldingBySource removes only rows from the specified source', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId, tokenId } = await makeHoldingFixture(tx);
      await repo().bulkUpsert(
        [
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '1',
            occurredAt: new Date('2024-06-01T00:00:00Z'),
            source: 'kraken-api',
            externalId: 'k1',
          },
          {
            userId,
            holdingId,
            tokenId,
            kind: 'deposit',
            quantity: '2',
            occurredAt: new Date('2024-06-02T00:00:00Z'),
            source: 'manual',
            externalId: 'm1',
          },
        ],
        tx
      );
      const removed = await repo().deleteForHoldingBySource(holdingId, 'kraken-api', tx);
      expect(removed).toBe(1);
      // Only the manual row remains.
      const remaining = await repo().findForHoldingInRange(
        holdingId,
        new Date('2024-01-01'),
        new Date('2025-01-01'),
        tx
      );
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.source).toBe('manual');
    });
  });
});
