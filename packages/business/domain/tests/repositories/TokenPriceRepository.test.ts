import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { TokenPriceRepository } from '../../src/repositories/TokenPriceRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeToken } from '../../test/helpers/factories-extra';

// TokenPriceRepository is the pricing read path for every dashboard query.
// The two subtle bits are: (1) `bulkUpsert` must not drop rows on conflict
// with the (tokenId, baseTokenId, timestamp) composite unique, and (2)
// `findLatestPricesForTokens` must group-by-token in memory — pin the
// "one row per tokenId" semantics so a refactor doesn't regress.

const repo = () => Container.get(TokenPriceRepository);

describe('TokenPriceRepository', () => {
  test('findLatestPrice returns null when no prices exist', async () => {
    await withTestDb(async (tx) => {
      const token = await makeToken(tx);
      const base = await makeToken(tx);
      expect(await repo().findLatestPrice(token.id, base.id, tx)).toBeNull();
    });
  });

  test('findLatestPrice returns the newest price by timestamp', async () => {
    await withTestDb(async (tx) => {
      const token = await makeToken(tx);
      const base = await makeToken(tx);
      await repo().create(
        {
          tokenId: token.id,
          baseTokenId: base.id,
          price: '100',
          timestamp: new Date('2026-01-01T00:00:00Z'),
          source: 'test',
        },
        tx
      );
      await repo().create(
        {
          tokenId: token.id,
          baseTokenId: base.id,
          price: '200',
          timestamp: new Date('2026-02-01T00:00:00Z'),
          source: 'test',
        },
        tx
      );
      const latest = await repo().findLatestPrice(token.id, base.id, tx);
      expect(latest?.price).toBe('200');
    });
  });

  test('findLatestPricesForTokens returns one row per tokenId', async () => {
    await withTestDb(async (tx) => {
      const t1 = await makeToken(tx);
      const t2 = await makeToken(tx);
      const base = await makeToken(tx);
      await repo().create(
        {
          tokenId: t1.id,
          baseTokenId: base.id,
          price: '50',
          timestamp: new Date('2026-01-01T00:00:00Z'),
          source: 'test',
        },
        tx
      );
      await repo().create(
        {
          tokenId: t1.id,
          baseTokenId: base.id,
          price: '100',
          timestamp: new Date('2026-02-01T00:00:00Z'),
          source: 'test',
        },
        tx
      );
      await repo().create(
        {
          tokenId: t2.id,
          baseTokenId: base.id,
          price: '10',
          timestamp: new Date('2026-02-01T00:00:00Z'),
          source: 'test',
        },
        tx
      );
      const map = await repo().findLatestPricesForTokens([t1.id, t2.id], base.id, tx);
      expect(map.size).toBe(2);
      expect(map.get(t1.id)?.price).toBe('100');
      expect(map.get(t2.id)?.price).toBe('10');
    });
  });

  test('findLatestPricesForTokens short-circuits on empty input', async () => {
    await withTestDb(async (tx) => {
      const base = await makeToken(tx);
      const map = await repo().findLatestPricesForTokens([], base.id, tx);
      expect(map.size).toBe(0);
    });
  });

  test('bulkUpsert inserts rows and updates on conflict', async () => {
    await withTestDb(async (tx) => {
      const token = await makeToken(tx);
      const base = await makeToken(tx);
      const timestamp = new Date('2026-03-01T00:00:00Z');
      await repo().bulkUpsert(
        [{ tokenId: token.id, baseTokenId: base.id, price: '1', timestamp, source: 'first' }],
        tx
      );
      // Same (tokenId, baseTokenId, timestamp) — must UPDATE, not fail.
      await repo().bulkUpsert(
        [{ tokenId: token.id, baseTokenId: base.id, price: '2', timestamp, source: 'second' }],
        tx
      );
      const latest = await repo().findLatestPrice(token.id, base.id, tx);
      expect(latest?.price).toBe('2');
      expect(latest?.source).toBe('second');
    });
  });

  test('bulkUpsert short-circuits on empty array', async () => {
    await withTestDb(async (tx) => {
      expect(await repo().bulkUpsert([], tx)).toEqual([]);
    });
  });

  test('findClosestPrice returns the most recent row at-or-before a given timestamp', async () => {
    await withTestDb(async (tx) => {
      const token = await makeToken(tx);
      const base = await makeToken(tx);
      await repo().create(
        {
          tokenId: token.id,
          baseTokenId: base.id,
          price: '10',
          timestamp: new Date('2026-01-01T00:00:00Z'),
          source: 'test',
        },
        tx
      );
      await repo().create(
        {
          tokenId: token.id,
          baseTokenId: base.id,
          price: '20',
          timestamp: new Date('2026-02-01T00:00:00Z'),
          source: 'test',
        },
        tx
      );
      await repo().create(
        {
          tokenId: token.id,
          baseTokenId: base.id,
          price: '30',
          timestamp: new Date('2026-03-01T00:00:00Z'),
          source: 'test',
        },
        tx
      );
      // Query at mid-Feb — the Jan + early-Feb rows qualify; latest wins.
      const closest = await repo().findClosestPrice(
        token.id,
        base.id,
        new Date('2026-02-15T00:00:00Z'),
        tx
      );
      expect(closest?.price).toBe('20');
    });
  });
});
