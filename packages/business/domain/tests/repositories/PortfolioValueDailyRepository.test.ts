import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { PortfolioValueDailyRepository } from '../../src/repositories/PortfolioValueDailyRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeUser } from '../../test/helpers/factories';
import { makeToken } from '../../test/helpers/factories-extra';

const repo = () => Container.get(PortfolioValueDailyRepository);

describe('PortfolioValueDailyRepository', () => {
  test('upsert inserts a fresh row and returns it', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const usd = await makeToken(tx);
      const row = await repo().upsert(
        {
          userId: user.id,
          snapshotDate: '2024-06-01',
          baseCurrencyId: usd.id,
          totalValue: '12345.67',
          coverageQuality: 'full',
          holdingsWithKnownValue: 5,
          holdingsTotal: 5,
        },
        tx
      );
      expect(row.userId).toBe(user.id);
      expect(row.snapshotDate).toBe('2024-06-01');
      expect(row.totalValue).toBe('12345.67');
      expect(row.coverageQuality).toBe('full');
    });
  });

  test('upsert overwrites the value on conflict for (user, date, base)', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const usd = await makeToken(tx);
      await repo().upsert(
        {
          userId: user.id,
          snapshotDate: '2024-06-01',
          baseCurrencyId: usd.id,
          totalValue: '100',
          coverageQuality: 'partial',
          holdingsWithKnownValue: 3,
          holdingsTotal: 5,
        },
        tx
      );
      const after = await repo().upsert(
        {
          userId: user.id,
          snapshotDate: '2024-06-01',
          baseCurrencyId: usd.id,
          totalValue: '200',
          coverageQuality: 'full',
          holdingsWithKnownValue: 5,
          holdingsTotal: 5,
        },
        tx
      );
      expect(after.totalValue).toBe('200');
      expect(after.coverageQuality).toBe('full');
      expect(after.holdingsWithKnownValue).toBe(5);
    });
  });

  test('bulkUpsert short-circuits on empty input and inserts batches otherwise', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const usd = await makeToken(tx);
      const empty = await repo().bulkUpsert([], tx);
      expect(empty).toEqual([]);
      const inserted = await repo().bulkUpsert(
        [
          {
            userId: user.id,
            snapshotDate: '2024-06-01',
            baseCurrencyId: usd.id,
            totalValue: '100',
            coverageQuality: 'full',
            holdingsWithKnownValue: 1,
            holdingsTotal: 1,
          },
          {
            userId: user.id,
            snapshotDate: '2024-06-02',
            baseCurrencyId: usd.id,
            totalValue: '200',
            coverageQuality: 'full',
            holdingsWithKnownValue: 1,
            holdingsTotal: 1,
          },
        ],
        tx
      );
      expect(inserted).toHaveLength(2);
    });
  });

  test('findRange returns rows in [from, to] for the (user, base) tuple, ordered ascending', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const usd = await makeToken(tx);
      await repo().bulkUpsert(
        [
          {
            userId: user.id,
            snapshotDate: '2024-05-31',
            baseCurrencyId: usd.id,
            totalValue: '50',
            coverageQuality: 'full',
            holdingsWithKnownValue: 1,
            holdingsTotal: 1,
          },
          {
            userId: user.id,
            snapshotDate: '2024-06-15',
            baseCurrencyId: usd.id,
            totalValue: '60',
            coverageQuality: 'full',
            holdingsWithKnownValue: 1,
            holdingsTotal: 1,
          },
          {
            userId: user.id,
            snapshotDate: '2024-07-15',
            baseCurrencyId: usd.id,
            totalValue: '70',
            coverageQuality: 'full',
            holdingsWithKnownValue: 1,
            holdingsTotal: 1,
          },
          {
            userId: user.id,
            snapshotDate: '2024-08-01',
            baseCurrencyId: usd.id,
            totalValue: '80',
            coverageQuality: 'full',
            holdingsWithKnownValue: 1,
            holdingsTotal: 1,
          },
        ],
        tx
      );
      const rows = await repo().findRange(
        user.id,
        usd.id,
        new Date('2024-06-01T00:00:00Z'),
        new Date('2024-07-31T23:59:59Z'),
        tx
      );
      // June 15 + July 15 are within range; the May 31 and Aug 1 rows are excluded.
      expect(rows.map((r) => r.snapshotDate)).toEqual(['2024-06-15', '2024-07-15']);
    });
  });

  test('findLatest returns the most recent row for the (user, base) tuple', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const usd = await makeToken(tx);
      const empty = await repo().findLatest(user.id, usd.id, tx);
      expect(empty).toBeNull();
      await repo().bulkUpsert(
        [
          {
            userId: user.id,
            snapshotDate: '2024-06-01',
            baseCurrencyId: usd.id,
            totalValue: '100',
            coverageQuality: 'full',
            holdingsWithKnownValue: 1,
            holdingsTotal: 1,
          },
          {
            userId: user.id,
            snapshotDate: '2024-09-01',
            baseCurrencyId: usd.id,
            totalValue: '300',
            coverageQuality: 'full',
            holdingsWithKnownValue: 1,
            holdingsTotal: 1,
          },
          {
            userId: user.id,
            snapshotDate: '2024-07-01',
            baseCurrencyId: usd.id,
            totalValue: '200',
            coverageQuality: 'full',
            holdingsWithKnownValue: 1,
            holdingsTotal: 1,
          },
        ],
        tx
      );
      const latest = await repo().findLatest(user.id, usd.id, tx);
      expect(latest?.snapshotDate).toBe('2024-09-01');
      expect(latest?.totalValue).toBe('300');
    });
  });

  test('deleteForUser drops all rollup rows for the user, optionally scoped to a base currency', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const usd = await makeToken(tx);
      const eur = await makeToken(tx);
      await repo().bulkUpsert(
        [
          {
            userId: user.id,
            snapshotDate: '2024-06-01',
            baseCurrencyId: usd.id,
            totalValue: '100',
            coverageQuality: 'full',
            holdingsWithKnownValue: 1,
            holdingsTotal: 1,
          },
          {
            userId: user.id,
            snapshotDate: '2024-06-01',
            baseCurrencyId: eur.id,
            totalValue: '90',
            coverageQuality: 'full',
            holdingsWithKnownValue: 1,
            holdingsTotal: 1,
          },
          {
            userId: user.id,
            snapshotDate: '2024-07-01',
            baseCurrencyId: usd.id,
            totalValue: '110',
            coverageQuality: 'full',
            holdingsWithKnownValue: 1,
            holdingsTotal: 1,
          },
        ],
        tx
      );
      const usdDeleted = await repo().deleteForUser(user.id, usd.id, tx);
      expect(usdDeleted).toBe(2);
      // EUR row remains.
      const remaining = await repo().findLatest(user.id, eur.id, tx);
      expect(remaining?.totalValue).toBe('90');

      // Now drop everything for the user.
      const allDeleted = await repo().deleteForUser(user.id, undefined, tx);
      expect(allDeleted).toBe(1);
      const gone = await repo().findLatest(user.id, eur.id, tx);
      expect(gone).toBeNull();
    });
  });
});
