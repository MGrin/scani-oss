import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { HoldingBalanceObservationRepository } from '../../src/repositories/HoldingBalanceObservationRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeInstitutionType, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

const repo = () => Container.get(HoldingBalanceObservationRepository);

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

describe('HoldingBalanceObservationRepository', () => {
  test('append inserts a row and returns it', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId } = await makeHoldingFixture(tx);
      const row = await repo().append(
        {
          userId,
          holdingId,
          balance: '5',
          observedAt: new Date('2024-06-01T00:00:00Z'),
          source: 'sync-capture',
        },
        tx
      );
      expect(row).not.toBeNull();
      expect(row?.balance).toBe('5');
      expect(row?.source).toBe('sync-capture');
    });
  });

  test('append is idempotent on (holding_id, observed_at, source) — re-append returns null', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId } = await makeHoldingFixture(tx);
      const at = new Date('2024-06-01T00:00:00Z');
      const first = await repo().append(
        { userId, holdingId, balance: '5', observedAt: at, source: 'sync-capture' },
        tx
      );
      // Second append with the same dedup key — onConflictDoNothing returns
      // an empty result; the helper turns that into null.
      const second = await repo().append(
        { userId, holdingId, balance: '99', observedAt: at, source: 'sync-capture' },
        tx
      );
      expect(first).not.toBeNull();
      expect(second).toBeNull();
      // The original balance is preserved (we don't overwrite on conflict).
      const all = await repo().findForHoldingBetween(
        holdingId,
        new Date('2024-01-01T00:00:00Z'),
        new Date('2024-12-31T23:59:59Z'),
        tx
      );
      expect(all).toHaveLength(1);
      expect(all[0]?.balance).toBe('5');
    });
  });

  test('bulkAppend inserts a batch and returns inserted rows; empty input short-circuits', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId } = await makeHoldingFixture(tx);
      const empty = await repo().bulkAppend([], tx);
      expect(empty).toEqual([]);
      const inserted = await repo().bulkAppend(
        [
          {
            userId,
            holdingId,
            balance: '1',
            observedAt: new Date('2024-01-01T00:00:00Z'),
            source: 'sync-capture',
          },
          {
            userId,
            holdingId,
            balance: '2',
            observedAt: new Date('2024-02-01T00:00:00Z'),
            source: 'sync-capture',
          },
        ],
        tx
      );
      expect(inserted).toHaveLength(2);
    });
  });

  test('findLatestAtOrAfter returns the earliest observation at or after the cutoff', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId } = await makeHoldingFixture(tx);
      await repo().bulkAppend(
        [
          {
            userId,
            holdingId,
            balance: '1',
            observedAt: new Date('2024-01-01T00:00:00Z'),
            source: 'sync-capture',
          },
          {
            userId,
            holdingId,
            balance: '2',
            observedAt: new Date('2024-06-01T00:00:00Z'),
            source: 'sync-capture',
          },
          {
            userId,
            holdingId,
            balance: '3',
            observedAt: new Date('2024-12-01T00:00:00Z'),
            source: 'sync-capture',
          },
        ],
        tx
      );
      const r = await repo().findLatestAtOrAfter(holdingId, new Date('2024-05-01T00:00:00Z'), tx);
      // The earliest observation on-or-after May is the June one.
      expect(r?.balance).toBe('2');
      const tooLate = await repo().findLatestAtOrAfter(
        holdingId,
        new Date('2025-01-01T00:00:00Z'),
        tx
      );
      expect(tooLate).toBeNull();
    });
  });

  test('findLatestAtOrBefore returns the latest observation at or before the cutoff', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId } = await makeHoldingFixture(tx);
      await repo().bulkAppend(
        [
          {
            userId,
            holdingId,
            balance: '1',
            observedAt: new Date('2024-01-01T00:00:00Z'),
            source: 'sync-capture',
          },
          {
            userId,
            holdingId,
            balance: '2',
            observedAt: new Date('2024-06-01T00:00:00Z'),
            source: 'sync-capture',
          },
          {
            userId,
            holdingId,
            balance: '3',
            observedAt: new Date('2024-12-01T00:00:00Z'),
            source: 'sync-capture',
          },
        ],
        tx
      );
      const r = await repo().findLatestAtOrBefore(holdingId, new Date('2024-07-01T00:00:00Z'), tx);
      // The latest observation on-or-before July is the June one.
      expect(r?.balance).toBe('2');
      const tooEarly = await repo().findLatestAtOrBefore(
        holdingId,
        new Date('2023-01-01T00:00:00Z'),
        tx
      );
      expect(tooEarly).toBeNull();
    });
  });

  test('findForHoldingBetween returns observations in [from, to] ordered ascending', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId } = await makeHoldingFixture(tx);
      const t1 = new Date('2024-03-01T00:00:00Z');
      const t2 = new Date('2024-06-01T00:00:00Z');
      const t3 = new Date('2024-09-01T00:00:00Z');
      const tOut = new Date('2025-01-01T00:00:00Z');
      await repo().bulkAppend(
        [
          { userId, holdingId, balance: '1', observedAt: t2, source: 's' },
          { userId, holdingId, balance: '2', observedAt: tOut, source: 's' },
          { userId, holdingId, balance: '3', observedAt: t1, source: 's' },
          { userId, holdingId, balance: '4', observedAt: t3, source: 's' },
        ],
        tx
      );
      const rows = await repo().findForHoldingBetween(
        holdingId,
        new Date('2024-01-01T00:00:00Z'),
        new Date('2024-12-31T23:59:59Z'),
        tx
      );
      expect(rows.map((r) => r.observedAt.getTime())).toEqual([
        t1.getTime(),
        t2.getTime(),
        t3.getTime(),
      ]);
    });
  });

  test('findExtremesForHolding returns null/null on empty and earliest/latest otherwise', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId } = await makeHoldingFixture(tx);
      const emptyExtremes = await repo().findExtremesForHolding(holdingId, tx);
      expect(emptyExtremes.first).toBeNull();
      expect(emptyExtremes.last).toBeNull();
      const tEarly = new Date('2023-01-01T00:00:00Z');
      const tLate = new Date('2025-09-30T00:00:00Z');
      await repo().bulkAppend(
        [
          { userId, holdingId, balance: '1', observedAt: tEarly, source: 's' },
          { userId, holdingId, balance: '2', observedAt: tLate, source: 's' },
        ],
        tx
      );
      const e = await repo().findExtremesForHolding(holdingId, tx);
      expect(e.first?.getTime()).toBe(tEarly.getTime());
      expect(e.last?.getTime()).toBe(tLate.getTime());
    });
  });
});
