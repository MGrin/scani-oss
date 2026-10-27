import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { returnsDataVersionSql } from '@scani/domain/services';
import {
  makeAccount,
  makeHolding,
  makeInstitution,
  makeToken,
  makeUser,
  withTestDb,
} from '@scani/domain/test-helpers';
import { eq, sql } from 'drizzle-orm';

// SC-1741: every returns request reads this version first. Its observation part
// counted every balance observation the user has, a scan of the whole table
// for an account with a long history, and on a Neon compute fresh from a
// suspend that scan took 5.2 s. What it needs is bounded.
describe('returns data version reads (SC-1741)', () => {
  test("reads a bounded number of the user's balance observations", async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const usd = await makeToken(tx);
      const inst = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
      const holding = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: usd.id,
      });
      const start = Date.UTC(2025, 0, 1);
      await tx.insert(schema.holdingBalanceObservations).values(
        Array.from({ length: 400 }, (_, i) => ({
          userId: user.id,
          holdingId: holding.id,
          balance: String(i),
          observedAt: new Date(start + i * 86_400_000),
          source: 'test',
        }))
      );
      // Planner statistics as production has them; an unanalysed table reads as empty.
      await tx.execute(sql`analyze holding_balance_observations`);
      const rowsRead = async () => {
        const [stats] = await tx.execute<{ n: string }>(
          sql`select coalesce(seq_tup_read, 0) + coalesce(idx_tup_fetch, 0) as n from pg_stat_xact_user_tables where relname = 'holding_balance_observations'`
        );
        return Number(stats?.n ?? 0);
      };

      const before = await rowsRead();
      const [row] = await tx.execute<{ v: string }>(returnsDataVersionSql(user.id));
      const read = (await rowsRead()) - before;

      // Non-vacuous: the version still carries the observations' newest write.
      expect(row?.v).toContain(':');
      expect(read).toBeGreaterThan(0);
      expect(read).toBeLessThan(10);
    });
  });

  // The count it no longer takes: a new observation and a gap review must each
  // still move the version. created_at is explicit because now() is fixed for
  // a whole transaction, and production writes land in separate ones.
  test('a new observation and a gap review each move the version', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const usd = await makeToken(tx);
      const inst = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
      const holding = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: usd.id,
      });
      const observe = (day: number) =>
        tx
          .insert(schema.holdingBalanceObservations)
          .values({
            userId: user.id,
            holdingId: holding.id,
            balance: String(day),
            observedAt: new Date(Date.UTC(2026, 0, day)),
            source: 'test',
            createdAt: new Date(Date.UTC(2026, 0, day, 12)),
          })
          .returning({ id: schema.holdingBalanceObservations.id });
      const version = async () => {
        const [row] = await tx.execute<{ v: string }>(returnsDataVersionSql(user.id));
        return row?.v;
      };

      const [first] = await observe(1);
      const v1 = await version();
      expect(await version()).toBe(v1);
      await observe(2);
      const v2 = await version();
      expect(v2).not.toBe(v1);
      if (!first) throw new Error('observation insert failed');
      await tx
        .update(schema.holdingBalanceObservations)
        .set({ gapReviewedAt: new Date(Date.UTC(2026, 0, 3)) })
        .where(eq(schema.holdingBalanceObservations.id, first.id));
      expect(await version()).not.toBe(v2);
    });
  });
});
