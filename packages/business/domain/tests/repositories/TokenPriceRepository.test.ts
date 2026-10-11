import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import { Container } from 'typedi';
import { TokenPriceRepository } from '../../src/repositories/TokenPriceRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeToken } from '../../test/helpers/factories-extra';

// TokenPriceRepository is the pricing read path for every dashboard query.
// The two subtle bits are: (1) `bulkUpsert` must not drop rows on conflict
// with the (tokenId, baseTokenId, timestamp) composite unique, and (2)
// `findLatestPricesForTokens` must answer one row per token — pin it so a
// refactor doesn't regress.

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

  // SC-1283. The per-user history backfill asks which of its tokens' days are
  // already priced. Unscoped, that read returned every token on the platform
  // and its first allocation grew with the whole table.
  describe('findPricedDayKeys', () => {
    const at = (iso: string) => new Date(iso);
    async function seed(tx: DatabaseTransaction) {
      const mine = await makeToken(tx);
      const theirs = await makeToken(tx);
      const usd = await makeToken(tx);
      for (const [tokenId, ts, granularity] of [
        [mine.id, '2026-03-01T00:00:00Z', 'daily'],
        [mine.id, '2026-03-02T15:30:00Z', 'intraday'],
        [mine.id, '2026-01-01T00:00:00Z', 'daily'],
        [theirs.id, '2026-03-01T00:00:00Z', 'daily'],
      ] as const) {
        await repo().create(
          {
            tokenId,
            baseTokenId: usd.id,
            price: '1',
            timestamp: at(ts),
            granularity,
            source: 'test',
          },
          tx
        );
      }
      return { mine: mine.id, theirs: theirs.id, usd: usd.id };
    }

    test('returns only the named tokens, one key per UTC day at or after `since`', async () => {
      await withTestDb(async (tx) => {
        const t = await seed(tx);
        const keys = await repo().findPricedDayKeys(
          { baseTokenId: t.usd, since: at('2026-02-01T00:00:00Z'), tokenIds: [t.mine] },
          tx
        );
        expect([...keys].sort()).toEqual([`${t.mine}:2026-03-01`, `${t.mine}:2026-03-02`]);
      });
    });

    test('an empty token list reads nothing', async () => {
      await withTestDb(async (tx) => {
        const t = await seed(tx);
        const keys = await repo().findPricedDayKeys(
          { baseTokenId: t.usd, since: at('2025-01-01T00:00:00Z'), tokenIds: [] },
          tx
        );
        expect(keys.size).toBe(0);
      });
    });

    test('no token list means every token but the base, for the all-users cron', async () => {
      await withTestDb(async (tx) => {
        const t = await seed(tx);
        const keys = await repo().findPricedDayKeys(
          { baseTokenId: t.usd, since: at('2026-02-01T00:00:00Z') },
          tx
        );
        expect(keys.has(`${t.theirs}:2026-03-01`)).toBe(true);
        expect(keys.has(`${t.mine}:2026-03-01`)).toBe(true);
      });
    });
  });
});

// Foundation A3, Task 13. A past day is covered by a daily row, by a non-manual
// reading in its last hour, or, once older than SETTLED_HISTORY_DAYS, by any
// reading. Today is covered by any reading since it began.
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The UTC midnight `n` days before today's. */
function dayStart(n: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - n * DAY_MS);
}

const dayOf = (at: Date) => at.toISOString().slice(0, 10);

async function seedPrice(
  tx: DatabaseTransaction,
  pair: { tokenId: string; baseTokenId: string },
  at: Date,
  row: { price?: string; granularity?: 'daily' | 'intraday'; source?: string } = {}
) {
  await repo().create(
    {
      ...pair,
      price: row.price ?? '2',
      timestamp: at,
      granularity: row.granularity ?? 'intraday',
      source: row.source ?? 'test',
    },
    tx
  );
}

async function pricePair(tx: DatabaseTransaction) {
  return { tokenId: (await makeToken(tx)).id, baseTokenId: (await makeToken(tx)).id };
}

async function coveredDays(
  tx: DatabaseTransaction,
  pair: { tokenId: string; baseTokenId: string }
): Promise<string[]> {
  const keys = await repo().findPricedDayKeys(
    { baseTokenId: pair.baseTokenId, tokenIds: [pair.tokenId], since: dayStart(40) },
    tx
  );
  return [...keys].map((key) => key.slice(pair.tokenId.length + 1)).sort();
}

describe('findPricedDayKeys: what covers a day', () => {
  test('a past day whose only reading is at 03:30 is not covered; one with a 23:10 reading is', async () => {
    await withTestDb(async (tx) => {
      const pair = await pricePair(tx);
      await seedPrice(tx, pair, new Date(dayStart(2).getTime() + 3.5 * HOUR_MS));
      await seedPrice(tx, pair, new Date(dayStart(3).getTime() + 23 * HOUR_MS + 10 * 60_000));

      expect(await coveredDays(tx, pair)).toEqual([dayOf(dayStart(3))]);
    });
  });

  test('CONTROL: a past day with a daily row of any source is covered', async () => {
    await withTestDb(async (tx) => {
      const pair = await pricePair(tx);
      await seedPrice(tx, pair, new Date(dayStart(2).getTime() + DAY_MS - 1), {
        granularity: 'daily',
        source: 'coingecko_historical',
      });
      await seedPrice(tx, pair, dayStart(3), { granularity: 'daily', source: 'downsample-daily' });

      expect(await coveredDays(tx, pair)).toEqual([dayOf(dayStart(3)), dayOf(dayStart(2))]);
    });
  });

  test('a 14:00 reading more than 7 days old still covers its day', async () => {
    await withTestDb(async (tx) => {
      const pair = await pricePair(tx);
      await seedPrice(tx, pair, new Date(dayStart(30).getTime() + 14 * HOUR_MS));

      expect(await coveredDays(tx, pair)).toEqual([dayOf(dayStart(30))]);
    });
  });

  test('a 14:00 reading two days old does not cover its day', async () => {
    await withTestDb(async (tx) => {
      const pair = await pricePair(tx);
      await seedPrice(tx, pair, new Date(dayStart(2).getTime() + 14 * HOUR_MS));

      expect(await coveredDays(tx, pair)).toEqual([]);
    });
  });

  test('a day seven days old is not settled: neither its 00:00 nor its 14:00 reading covers it', async () => {
    await withTestDb(async (tx) => {
      const pair = await pricePair(tx);
      await seedPrice(tx, pair, dayStart(7));
      await seedPrice(tx, pair, new Date(dayStart(7).getTime() + 14 * HOUR_MS));

      expect(await coveredDays(tx, pair)).toEqual([]);
    });
  });

  test('a 14:00 reading eight days old covers its day', async () => {
    await withTestDb(async (tx) => {
      const pair = await pricePair(tx);
      await seedPrice(tx, pair, new Date(dayStart(8).getTime() + 14 * HOUR_MS));

      expect(await coveredDays(tx, pair)).toEqual([dayOf(dayStart(8))]);
    });
  });

  test('a manual reading at 23:30 does not cover a recent past day', async () => {
    await withTestDb(async (tx) => {
      const pair = await pricePair(tx);
      await seedPrice(tx, pair, new Date(dayStart(2).getTime() + 23.5 * HOUR_MS), {
        source: 'manual',
      });

      expect(await coveredDays(tx, pair)).toEqual([]);
    });
  });

  test('CONTROL: today is covered by any reading since it began', async () => {
    await withTestDb(async (tx) => {
      const pair = await pricePair(tx);
      // Its first instant: a reading in the last hour would cover the day by
      // that rule alone, so a run in UTC hour 23 would prove nothing here.
      await seedPrice(tx, pair, dayStart(0));

      expect(await coveredDays(tx, pair)).toEqual([dayOf(dayStart(0))]);
    });
  });
});
