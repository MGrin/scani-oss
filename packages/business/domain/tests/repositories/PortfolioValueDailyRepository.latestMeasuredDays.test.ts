import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { PortfolioValueDailyRepository } from '../../src/repositories/PortfolioValueDailyRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

const repo = () => Container.get(PortfolioValueDailyRepository);

async function holdingRow(
  tx: Parameters<Parameters<typeof withTestDb>[0]>[0],
  userId: string,
  holdingId: string,
  baseCurrencyId: string,
  snapshotDate: string,
  holdingsWithKnownValue = 1
) {
  await repo().upsert(
    {
      userId,
      snapshotDate,
      baseCurrencyId,
      totalValue: '100',
      coverageQuality: 'full',
      holdingsWithKnownValue,
      holdingsTotal: 1,
      scopeKind: 'holding' as const,
      scopeId: holdingId,
    },
    tx
  );
}

describe('PortfolioValueDailyRepository.findLatestMeasuredDays (SC-1306)', () => {
  test('a day with many holdings counts ONCE — two rows on one day is one measured day', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const usd = await makeToken(tx);
      const inst = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
      const a = await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: usd.id });
      const b = await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: usd.id });
      const c = await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: usd.id });

      // Three holdings on the SAME day, then two on an earlier day.
      for (const h of [a, b, c]) await holdingRow(tx, user.id, h.id, usd.id, '2026-03-10');
      for (const h of [a, b]) await holdingRow(tx, user.id, h.id, usd.id, '2026-03-04');

      const days = await repo().findLatestMeasuredDays(
        user.id,
        usd.id,
        new Date('2026-01-01'),
        new Date('2026-12-31'),
        2,
        tx
      );

      expect(days).toEqual(['2026-03-10', '2026-03-04']);
    });
  });

  test('one measured day is one day, however many holdings it has', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const usd = await makeToken(tx);
      const inst = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
      const a = await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: usd.id });
      const b = await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: usd.id });

      for (const h of [a, b]) await holdingRow(tx, user.id, h.id, usd.id, '2026-03-10');

      const days = await repo().findLatestMeasuredDays(
        user.id,
        usd.id,
        new Date('2026-01-01'),
        new Date('2026-12-31'),
        2,
        tx
      );

      // One day, not two — this is the bit `hasHistory` reads to decide there
      // is nothing to measure a return over.
      expect(days).toEqual(['2026-03-10']);
    });
  });

  test('a day with nothing priced is not a measured day', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const usd = await makeToken(tx);
      const inst = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
      const h = await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: usd.id });

      await holdingRow(tx, user.id, h.id, usd.id, '2026-03-10', 0);
      await holdingRow(tx, user.id, h.id, usd.id, '2026-03-04', 1);

      const days = await repo().findLatestMeasuredDays(
        user.id,
        usd.id,
        new Date('2026-01-01'),
        new Date('2026-12-31'),
        2,
        tx
      );

      expect(days).toEqual(['2026-03-04']);
    });
  });

  test('days outside the range are not returned, on either side', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const usd = await makeToken(tx);
      const inst = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
      const h = await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: usd.id });

      for (const d of ['2026-01-05', '2026-03-04', '2026-03-10', '2026-06-20'])
        await holdingRow(tx, user.id, h.id, usd.id, d);

      const days = await repo().findLatestMeasuredDays(
        user.id,
        usd.id,
        new Date('2026-02-01'),
        new Date('2026-04-01'),
        2,
        tx
      );

      expect(days).toEqual(['2026-03-10', '2026-03-04']);
    });
  });

  test('another user’s days are never visible', async () => {
    await withTestDb(async (tx) => {
      const mine = await makeUser(tx);
      const theirs = await makeUser(tx);
      const usd = await makeToken(tx);
      const inst = await makeInstitution(tx);
      const myAccount = await makeAccount(tx, { userId: mine.id, institutionId: inst.id });
      const theirAccount = await makeAccount(tx, { userId: theirs.id, institutionId: inst.id });
      const myHolding = await makeHolding(tx, {
        userId: mine.id,
        accountId: myAccount.id,
        tokenId: usd.id,
      });
      const theirHolding = await makeHolding(tx, {
        userId: theirs.id,
        accountId: theirAccount.id,
        tokenId: usd.id,
      });

      await holdingRow(tx, mine.id, myHolding.id, usd.id, '2026-03-04');
      await holdingRow(tx, theirs.id, theirHolding.id, usd.id, '2026-03-10');

      const days = await repo().findLatestMeasuredDays(
        mine.id,
        usd.id,
        new Date('2026-01-01'),
        new Date('2026-12-31'),
        2,
        tx
      );

      expect(days).toEqual(['2026-03-04']);
    });
  });

  test('no rows at all is an empty answer, not a throw', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const usd = await makeToken(tx);
      const days = await repo().findLatestMeasuredDays(
        user.id,
        usd.id,
        new Date('2026-01-01'),
        new Date('2026-12-31'),
        2,
        tx
      );
      expect(days).toEqual([]);
    });
  });

  test('an empty holding filter asks about nothing and reads nothing', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const usd = await makeToken(tx);
      const days = await repo().findLatestMeasuredDays(
        user.id,
        usd.id,
        new Date('2026-01-01'),
        new Date('2026-12-31'),
        2,
        tx,
        []
      );
      expect(days).toEqual([]);
    });
  });

  test('a holding filter narrows to those holdings’ days', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const usd = await makeToken(tx);
      const inst = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
      const a = await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: usd.id });
      const b = await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: usd.id });

      await holdingRow(tx, user.id, a.id, usd.id, '2026-03-04');
      await holdingRow(tx, user.id, b.id, usd.id, '2026-03-10');

      const days = await repo().findLatestMeasuredDays(
        user.id,
        usd.id,
        new Date('2026-01-01'),
        new Date('2026-12-31'),
        2,
        tx,
        [a.id]
      );

      expect(days).toEqual(['2026-03-04']);
    });
  });

  // SC-1369 moved the inclusion contract out of a join and into the
  // ANY(ARRAY(...)) subquery that makes this one bitmap scan. These pin that
  // every exclusion survived the move.
  test('hidden, inactive and scam-scored holdings are not measured days', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const usd = await makeToken(tx);
      const scamToken = await makeToken(tx, { isScamProbability: 0.99 });
      const inst = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
      const shown = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: usd.id,
      });
      const hidden = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: usd.id,
        isHidden: true,
      });
      const inactive = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: usd.id,
        isActive: false,
      });
      const scam = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: scamToken.id,
      });

      await holdingRow(tx, user.id, shown.id, usd.id, '2026-03-01');
      await holdingRow(tx, user.id, hidden.id, usd.id, '2026-03-05');
      await holdingRow(tx, user.id, inactive.id, usd.id, '2026-03-06');
      await holdingRow(tx, user.id, scam.id, usd.id, '2026-03-07');

      const days = await repo().findLatestMeasuredDays(
        user.id,
        usd.id,
        new Date('2026-01-01'),
        new Date('2026-12-31'),
        2,
        tx
      );

      expect(days).toEqual(['2026-03-01']);
    });
  });

  test('a user’s own scam verdict excludes the holding, and their not-scam verdict includes it', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const usd = await makeToken(tx);
      const flagged = await makeToken(tx);
      const cleared = await makeToken(tx, { isScamProbability: 0.99 });
      const inst = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
      const a = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: flagged.id,
      });
      const b = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: cleared.id,
      });
      await tx.insert(schema.userTokenScamVerdicts).values([
        { userId: user.id, tokenId: flagged.id, verdict: 'scam' },
        { userId: user.id, tokenId: cleared.id, verdict: 'not_scam' },
      ]);

      await holdingRow(tx, user.id, a.id, usd.id, '2026-03-09');
      await holdingRow(tx, user.id, b.id, usd.id, '2026-03-02');

      const days = await repo().findLatestMeasuredDays(
        user.id,
        usd.id,
        new Date('2026-01-01'),
        new Date('2026-12-31'),
        2,
        tx
      );

      expect(days).toEqual(['2026-03-02']);
    });
  });

  test('rows in another base currency are not measured days in this one', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const usd = await makeToken(tx);
      const eur = await makeToken(tx);
      const inst = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
      const a = await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: usd.id });

      await holdingRow(tx, user.id, a.id, usd.id, '2026-03-01');
      await holdingRow(tx, user.id, a.id, eur.id, '2026-03-08');

      const days = await repo().findLatestMeasuredDays(
        user.id,
        usd.id,
        new Date('2026-01-01'),
        new Date('2026-12-31'),
        2,
        tx
      );

      expect(days).toEqual(['2026-03-01']);
    });
  });
});

// SC-1741: the newest measured days were found by reading every holding row in
// the window, a year of rows for every holding, to keep two.
// On a Neon compute fresh from a suspend each of those pages came from
// storage: 5.5 s. The newest days per holding are a bounded read.
describe('findLatestMeasuredDays reads (SC-1741)', () => {
  test('reads the newest days, not the whole window', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const usd = await makeToken(tx);
      const inst = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
      const h = await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: usd.id });
      for (let i = 0; i < 400; i++) {
        const day = new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
        await holdingRow(tx, user.id, h.id, usd.id, day);
      }
      // Planner statistics as production has them; an unanalysed table reads as empty.
      await tx.execute(sql`analyze portfolio_value_daily`);
      const rowsRead = async () => {
        const [stats] = await tx.execute<{ n: string }>(
          sql`select coalesce(seq_tup_read, 0) + coalesce(idx_tup_fetch, 0) as n from pg_stat_xact_user_tables where relname = 'portfolio_value_daily'`
        );
        return Number(stats?.n ?? 0);
      };

      const before = await rowsRead();
      const days = await repo().findLatestMeasuredDays(
        user.id,
        usd.id,
        new Date('2025-01-01'),
        new Date('2026-12-31'),
        2,
        tx
      );
      const read = (await rowsRead()) - before;

      expect(days).toEqual(['2026-02-04', '2026-02-03']);
      expect(read).toBeGreaterThan(0);
      expect(read).toBeLessThan(20);
    });
  });
});
