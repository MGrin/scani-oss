import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import Decimal from 'decimal.js';
import { eq, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { PortfolioValueDailyRepository } from '../../src/repositories/PortfolioValueDailyRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
} from '../../test/helpers/factories-extra';

const repo = () => Container.get(PortfolioValueDailyRepository);

// Default scope for tests = user-wide (the existing behavior). The
// per-entity scope is exercised separately in the rollup integration
// tests; this repository test focuses on the upsert + range read
// surface, where scope is just a tagged tuple.
function userScopeRow<T extends { userId: string }>(
  row: T
): T & {
  scopeKind: 'user';
  scopeId: string;
} {
  return { ...row, scopeKind: 'user' as const, scopeId: row.userId };
}

describe('PortfolioValueDailyRepository', () => {
  test('upsert inserts a fresh row and returns it', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const usd = await makeToken(tx);
      const row = await repo().upsert(
        userScopeRow({
          userId: user.id,
          snapshotDate: '2024-06-01',
          baseCurrencyId: usd.id,
          totalValue: '12345.67',
          coverageQuality: 'full',
          holdingsWithKnownValue: 5,
          holdingsTotal: 5,
        }),
        tx
      );
      expect(row?.userId).toBe(user.id);
      expect(row?.snapshotDate).toBe('2024-06-01');
      expect(row?.totalValue).toBe('12345.67');
      expect(row?.coverageQuality).toBe('full');
    });
  });

  test('upsert overwrites the value on conflict for (user, date, base)', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const usd = await makeToken(tx);
      await repo().upsert(
        userScopeRow({
          userId: user.id,
          snapshotDate: '2024-06-01',
          baseCurrencyId: usd.id,
          totalValue: '100',
          coverageQuality: 'partial',
          holdingsWithKnownValue: 3,
          holdingsTotal: 5,
        }),
        tx
      );
      const after = await repo().upsert(
        userScopeRow({
          userId: user.id,
          snapshotDate: '2024-06-01',
          baseCurrencyId: usd.id,
          totalValue: '200',
          coverageQuality: 'full',
          holdingsWithKnownValue: 5,
          holdingsTotal: 5,
        }),
        tx
      );
      expect(after?.totalValue).toBe('200');
      expect(after?.coverageQuality).toBe('full');
      expect(after?.holdingsWithKnownValue).toBe(5);
    });
  });

  // SC-1320: the api's returns cache keys on the newest computed_at, and a
  // history backfill re-derives hundreds of unchanged days per run.
  test('a re-run that reproduces the values leaves computed_at alone; a change moves it', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const usd = await makeToken(tx);
      const earlier = new Date('2024-06-02T04:00:00Z');
      const base = userScopeRow({
        userId: user.id,
        snapshotDate: '2024-06-01',
        baseCurrencyId: usd.id,
        totalValue: '100',
        coverageQuality: 'full' as const,
        holdingsWithKnownValue: 5,
        holdingsTotal: 5,
        costBasis: '80',
      });
      await repo().upsert({ ...base, computedAt: earlier }, tx);

      const unchanged = await repo().upsert(base, tx);
      expect(unchanged).toBeNull();
      expect((await repo().findLatest(user.id, usd.id, tx))?.computedAt).toEqual(earlier);

      // The control: one derived column moves, and the row is rewritten.
      const changed = await repo().upsert({ ...base, costBasis: '81' }, tx);
      expect(changed?.costBasis).toBe('81');
      expect(changed?.computedAt).not.toEqual(earlier);

      const bulk = await repo().bulkUpsert([{ ...base, costBasis: '81' }], tx);
      expect(bulk).toHaveLength(0);
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
        ].map(userScopeRow),
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
        ].map(userScopeRow),
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
        ].map(userScopeRow),
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
        ].map(userScopeRow),
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

describe('PortfolioValueDailyRepository.findHistoryLookbackDays', () => {
  const FLOOR = 400;
  // Stamped by the database's own calendar, at noon. The method counts in the
  // database's days, and `current_date` holds still for the one transaction a
  // test runs in, so the distance is exact whenever the test runs.
  const daysBack = (days: number) => sql`(current_date - ${days}::integer) + interval '12 hours'`;

  /** A user whose one ledger row is `days` back; the holding it sits on. */
  async function userWithLedgerRow(tx: DatabaseTransaction, days: number) {
    const user = await makeUser(tx);
    const row = await makeHoldingTransaction(tx, { userId: user.id });
    await tx
      .update(schema.holdingTransactions)
      .set({ occurredAt: daysBack(days) })
      .where(eq(schema.holdingTransactions.id, row.id));
    return { userId: user.id, holdingId: row.holdingId };
  }

  test('a ledger row 500 days back reaches 502 days', async () => {
    await withTestDb(async (tx) => {
      const { userId } = await userWithLedgerRow(tx, 500);
      expect(await repo().findHistoryLookbackDays(userId, FLOOR, tx)).toBe(502);
    });
  });

  test('history no older than the floor gets the floor', async () => {
    await withTestDb(async (tx) => {
      const recent = await userWithLedgerRow(tx, 100);
      const justInside = await userWithLedgerRow(tx, 398);
      const justOutside = await userWithLedgerRow(tx, 399);
      expect(await repo().findHistoryLookbackDays(recent.userId, FLOOR, tx)).toBe(400);
      expect(await repo().findHistoryLookbackDays(justInside.userId, FLOOR, tx)).toBe(400);
      expect(await repo().findHistoryLookbackDays(justOutside.userId, FLOOR, tx)).toBe(401);
    });
  });

  test('no history at all gets the floor, whatever anyone else has', async () => {
    await withTestDb(async (tx) => {
      await userWithLedgerRow(tx, 900);
      const fresh = await makeUser(tx);
      expect(await repo().findHistoryLookbackDays(fresh.id, FLOOR, tx)).toBe(400);
    });
  });

  test('a balance reading older than the ledger sets it', async () => {
    await withTestDb(async (tx) => {
      const read = await userWithLedgerRow(tx, 410);
      await tx.insert(schema.holdingBalanceObservations).values({
        userId: read.userId,
        holdingId: read.holdingId,
        balance: '1',
        observedAt: daysBack(450),
        source: 'sync-capture',
      });
      expect(await repo().findHistoryLookbackDays(read.userId, FLOOR, tx)).toBe(452);
    });
  });

  // The rollup's own output is not history: counting it made every full
  // rebuild start one day before the oldest row the last one wrote (SC-1627).
  test('a stored day older than every record does not move it', async () => {
    await withTestDb(async (tx) => {
      const stored = await userWithLedgerRow(tx, 410);
      await storedRow(tx, stored.userId, sql`current_date - 600`);
      expect(await repo().findHistoryLookbackDays(stored.userId, FLOOR, tx)).toBe(412);
    });
  });
});

/** One user-scope rollup row on `day`, in a fresh base currency unless one is given. */
async function storedRow(
  tx: DatabaseTransaction,
  userId: string,
  day: ReturnType<typeof sql> | string,
  opts: { baseCurrencyId?: string; scopeKind?: string; scopeId?: string } = {}
) {
  await tx.insert(schema.portfolioValueDaily).values({
    userId,
    scopeKind: opts.scopeKind ?? 'user',
    scopeId: opts.scopeId ?? userId,
    snapshotDate: day as string,
    baseCurrencyId: opts.baseCurrencyId ?? (await makeToken(tx)).id,
    totalValue: '1',
    coverageQuality: 'full',
    holdingsWithKnownValue: 1,
    holdingsTotal: 1,
  });
}

describe('PortfolioValueDailyRepository — rows before the earliest record (SC-1627)', () => {
  test('the earliest record day is the older of a ledger row and a reading, never a stored day', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const row = await makeHoldingTransaction(tx, { userId: user.id });
      await tx
        .update(schema.holdingTransactions)
        .set({ occurredAt: new Date('2025-06-10T12:00:00Z') })
        .where(eq(schema.holdingTransactions.id, row.id));
      await tx.insert(schema.holdingBalanceObservations).values({
        userId: user.id,
        holdingId: row.holdingId,
        balance: '1',
        observedAt: new Date('2025-06-03T08:00:00Z'),
        source: 'sync-capture',
      });
      await storedRow(tx, user.id, '2025-01-01');
      expect(await repo().findEarliestRecordDay(user.id, tx)).toBe('2025-06-03');

      const fresh = await makeUser(tx);
      await storedRow(tx, fresh.id, '2025-01-01');
      expect(await repo().findEarliestRecordDay(fresh.id, tx)).toBeNull();
    });
  });

  test('deleteBefore removes every scope of that user and base currency before the day, and nothing else', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const other = await makeUser(tx);
      const base = (await makeToken(tx)).id;
      const otherBase = (await makeToken(tx)).id;
      const holdingId = crypto.randomUUID();
      for (const scope of [
        { scopeKind: 'user', scopeId: user.id },
        { scopeKind: 'holding', scopeId: holdingId },
        { scopeKind: 'transit', scopeId: holdingId },
      ]) {
        await storedRow(tx, user.id, '2025-03-01', { baseCurrencyId: base, ...scope });
        await storedRow(tx, user.id, '2025-03-02', { baseCurrencyId: base, ...scope });
      }
      await storedRow(tx, user.id, '2025-03-01', { baseCurrencyId: otherBase });
      await storedRow(tx, other.id, '2025-03-01', { baseCurrencyId: base });

      expect(await repo().deleteBefore(user.id, base, '2025-03-02', tx)).toBe(3);

      const left = await tx
        .select({
          userId: schema.portfolioValueDaily.userId,
          day: schema.portfolioValueDaily.snapshotDate,
          base: schema.portfolioValueDaily.baseCurrencyId,
        })
        .from(schema.portfolioValueDaily)
        .where(sql`${schema.portfolioValueDaily.userId} in (${user.id}, ${other.id})`);
      expect(left.filter((r) => r.userId === user.id && r.base === base).map((r) => r.day)).toEqual(
        ['2025-03-02', '2025-03-02', '2025-03-02']
      );
      expect(left.filter((r) => r.base === otherBase)).toHaveLength(1);
      expect(left.filter((r) => r.userId === other.id)).toHaveLength(1);
    });
  });
});

describe('PortfolioValueDailyRepository — money in transit (SC-1675)', () => {
  const day = '2026-09-01';
  const from = new Date(`${day}T00:00:00Z`);
  const to = new Date(`${day}T23:59:59Z`);

  /** One holding at 1000 (cost 800) and 500 travelling to it, plus the controls. */
  async function travelling(tx: DatabaseTransaction) {
    const user = await makeUser(tx);
    const other = await makeUser(tx);
    const usd = await makeToken(tx);
    const institution = await makeInstitution(tx);
    const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
    const holding = await makeHolding(tx, {
      userId: user.id,
      accountId: account.id,
      tokenId: usd.id,
    });
    const hidden = await makeHolding(tx, {
      userId: user.id,
      accountId: account.id,
      tokenId: usd.id,
      isHidden: true,
      hiddenBy: 'user',
    });
    const otherAccount = await makeAccount(tx, { userId: other.id, institutionId: institution.id });
    const otherHolding = await makeHolding(tx, {
      userId: other.id,
      accountId: otherAccount.id,
      tokenId: usd.id,
    });
    const row = (
      userId: string,
      scopeKind: 'holding' | 'transit',
      scopeId: string,
      value: string
    ) => ({
      userId,
      scopeKind,
      scopeId,
      snapshotDate: day,
      baseCurrencyId: usd.id,
      coverageQuality: 'full' as const,
      totalValue: value,
      costBasis: scopeKind === 'holding' ? '800' : value,
      realizedPnl: '0',
      unrealizedPnl: scopeKind === 'holding' ? new Decimal(value).minus(800).toString() : '0',
      holdingsWithKnownValue: scopeKind === 'holding' ? 1 : 0,
      holdingsTotal: scopeKind === 'holding' ? 1 : 0,
    });
    await repo().bulkUpsert(
      [
        row(user.id, 'holding', holding.id, '1000'),
        row(user.id, 'transit', holding.id, '500'),
        // CONTROL: travelling to a holding its owner hid counts nowhere, as the
        // holding itself does not.
        row(user.id, 'transit', hidden.id, '300'),
        // CONTROL: another person's transit on the same day.
        row(other.id, 'transit', otherHolding.id, '70'),
      ],
      tx
    );
    return { userId: user.id, baseId: usd.id, holdingId: holding.id };
  }

  test("the daily sum adds the day's transit: value and cost, and no gain", async () => {
    await withTestDb(async (tx) => {
      const t = await travelling(tx);
      const [totals] = await repo().findIncludedHoldingDailyTotals(
        t.userId,
        t.baseId,
        from,
        to,
        tx
      );
      expect(totals?.totalValue).toBe('1500');
      expect(totals?.costBasis).toBe('1300');
      expect(totals?.unrealizedPnl).toBe('200');
      expect(totals?.holdingsTotal).toBe(1);
    });
  });

  test('at user scope the per-holding reads add transit to its destination', async () => {
    await withTestDb(async (tx) => {
      const t = await travelling(tx);
      const values = await repo().findIncludedHoldingValueRange(
        t.userId,
        t.baseId,
        from,
        to,
        undefined,
        tx
      );
      expect(values.map((r) => [r.holdingId, r.totalValue])).toEqual([[t.holdingId, '1500']]);
      const scoped = await repo().findIncludedHoldingScopeRange(t.userId, t.baseId, from, to, tx);
      expect(scoped.map((r) => [r.holdingId, r.totalValue, r.costBasis])).toEqual([
        [t.holdingId, '1500', '1300'],
      ]);
    });
  });

  test('CONTROL: a narrowed read (an account, a group) carries no transit', async () => {
    await withTestDb(async (tx) => {
      const t = await travelling(tx);
      const values = await repo().findIncludedHoldingValueRange(
        t.userId,
        t.baseId,
        from,
        to,
        [t.holdingId],
        tx
      );
      expect(values.map((r) => r.totalValue)).toEqual(['1000']);
    });
  });
});

describe('PortfolioValueDailyRepository — days before a holding counts (SC-1745)', () => {
  const before = '2026-09-01';
  const after = '2026-09-02';
  const from = new Date(`${before}T00:00:00Z`);
  const to = new Date(`${after}T23:59:59Z`);

  /**
   * `early` has a day before its first record and one after; `late` has only a
   * day before; `travelling` has a day before with money in transit to it.
   */
  async function rollup(tx: DatabaseTransaction) {
    const user = await makeUser(tx);
    const usd = await makeToken(tx);
    const institution = await makeInstitution(tx);
    const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
    const holding = () =>
      makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: usd.id });
    const [early, late, travelling, outside] = [
      await holding(),
      await holding(),
      await holding(),
      await holding(),
    ];
    const row = (
      scopeId: string,
      snapshotDate: string,
      counted: boolean,
      scopeKind: 'holding' | 'transit' = 'holding',
      value = counted ? '100' : '0'
    ) => ({
      userId: user.id,
      scopeKind,
      scopeId,
      snapshotDate,
      baseCurrencyId: usd.id,
      coverageQuality: counted ? ('full' as const) : ('unknown' as const),
      totalValue: value,
      costBasis: value,
      realizedPnl: '0',
      unrealizedPnl: '0',
      holdingsWithKnownValue: counted ? 1 : 0,
      holdingsTotal: counted ? 1 : 0,
    });
    await repo().bulkUpsert(
      [
        row(early.id, before, false),
        row(early.id, after, true),
        row(late.id, before, false),
        row(travelling.id, before, false),
        row(travelling.id, before, false, 'transit', '40'),
        row(outside.id, '2026-08-01', true),
      ],
      tx
    );
    return {
      userId: user.id,
      baseId: usd.id,
      early: early.id,
      late: late.id,
      travelling: travelling.id,
      outside: outside.id,
    };
  }

  test('the value range skips a day before a holding counts', async () => {
    await withTestDb(async (tx) => {
      const r = await rollup(tx);
      const scoped = await repo().findIncludedHoldingValueRange(
        r.userId,
        r.baseId,
        from,
        to,
        [r.early, r.late],
        tx
      );
      expect(scoped.map((v) => [v.holdingId, v.snapshotDate])).toEqual([[r.early, after]]);
    });
  });

  test('at user scope a transit destination keeps its day before it counts', async () => {
    // `subsetOf` adds that value on the last day, so dropping the row would
    // change an answer rather than only its cost.
    await withTestDb(async (tx) => {
      const r = await rollup(tx);
      const all = await repo().findIncludedHoldingValueRange(
        r.userId,
        r.baseId,
        from,
        to,
        undefined,
        tx
      );
      expect(all.map((v) => [v.holdingId, v.snapshotDate, v.totalValue]).sort()).toEqual(
        [
          [r.early, after, '100'],
          [r.travelling, before, '40'],
        ].sort()
      );
    });
  });

  test("a day's rows come in holding order, so a sum never depends on the plan", async () => {
    // Ordered by day alone, two plans summed one day in different orders and
    // a return moved in its 28th digit between two reads of the same data.
    await withTestDb(async (tx) => {
      const r = await rollup(tx);
      const [counted] = await repo().findIncludedHoldingValueRange(
        r.userId,
        r.baseId,
        from,
        to,
        [r.early],
        tx
      );
      const second = await tx
        .select()
        .from(schema.portfolioValueDaily)
        .where(eq(schema.portfolioValueDaily.scopeId, r.early));
      const template = second.find((row) => row.holdingsTotal > 0);
      if (!counted || !template) throw new Error('fixture has no counted day');
      // Written in descending holding order, so storage order is not the answer.
      const descending = [r.early, r.late, r.outside, r.travelling].sort().reverse();
      for (const scopeId of descending) {
        await repo().bulkUpsert([{ ...template, scopeId, snapshotDate: '2026-08-15' }], tx);
      }
      const rows = await repo().findIncludedHoldingValueRange(
        r.userId,
        r.baseId,
        new Date('2026-08-01T00:00:00Z'),
        to,
        undefined,
        tx
      );
      const keys = rows.map((v) => `${v.snapshotDate}|${v.holdingId}`);
      expect(keys).toEqual([...keys].sort());
      expect(new Set(rows.map((v) => v.snapshotDate)).size).toBeLessThan(rows.length);
    });
  });

  test('every holding with a row in range is named, counted or not', async () => {
    await withTestDb(async (tx) => {
      const r = await rollup(tx);
      const ids = await repo().findHoldingIdsInRange(r.userId, r.baseId, from, to, undefined, tx);
      expect([...ids].sort()).toEqual([r.early, r.late, r.travelling].sort());
      const narrowed = await repo().findHoldingIdsInRange(
        r.userId,
        r.baseId,
        from,
        to,
        [r.late],
        tx
      );
      expect([...narrowed]).toEqual([r.late]);
    });
  });
});
