import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingBalanceObservationRepository } from '../../src/repositories/HoldingBalanceObservationRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeInstitutionType, makeUser } from '../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
} from '../../test/helpers/factories-extra';

/**
 * The window query behind the balance-gap queue (SC-501).
 *
 * Worth its own database-backed suite rather than a stub, because the whole
 * risk lives in SQL the type system cannot see: the `LAG` partition, the
 * half-open transaction range, and the join back to holdings. The service's
 * unit tests take the candidate rows as given; nothing else proves those rows
 * are the right ones.
 *
 * The partitioning in particular has a measured failure behind it. On
 * 2026-08-22 an ad-hoc version of this query ordered a Tinkoff account's
 * observations by time WITHOUT partitioning by holding, and — because that
 * account carries four separate RUB holdings — `LAG` differenced rows from
 * different holdings against each other and invented a residual that does not
 * exist. `unpartitioned observations invent a gap` below is that case.
 */

const repo = () => Container.get(HoldingBalanceObservationRepository);

async function fixture(tx: DatabaseTransaction): Promise<{
  userId: string;
  accountId: string;
  tokenId: string;
}> {
  const user = await makeUser(tx);
  const instType = await makeInstitutionType(tx);
  const inst = await makeInstitution(tx, { typeId: instType.id });
  const account = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
  const token = await makeToken(tx);
  return { userId: user.id, accountId: account.id, tokenId: token.id };
}

async function observe(
  tx: DatabaseTransaction,
  row: { userId: string; holdingId: string; balance: string; observedAt: Date; source?: string }
): Promise<string> {
  const [inserted] = await tx
    .insert(schema.holdingBalanceObservations)
    .values({
      userId: row.userId,
      holdingId: row.holdingId,
      balance: row.balance,
      observedAt: row.observedAt,
      source: row.source ?? 'sync-capture',
    })
    .returning();
  if (!inserted) throw new Error('observation insert failed');
  return inserted.id;
}

const T0 = new Date('2026-06-01T00:00:00Z');
const T1 = new Date('2026-06-02T00:00:00Z');
const T2 = new Date('2026-06-03T00:00:00Z');

describe('findGapCandidatesForUser', () => {
  test('a balance change with no transaction is a candidate', async () => {
    await withTestDb(async (tx) => {
      const { userId, accountId, tokenId } = await fixture(tx);
      const holding = await makeHolding(tx, { userId, accountId, tokenId });
      await observe(tx, { userId, holdingId: holding.id, balance: '100', observedAt: T0 });
      const closing = await observe(tx, {
        userId,
        holdingId: holding.id,
        balance: '250',
        observedAt: T1,
      });

      const rows = await repo().findGapCandidatesForUser(userId, tx);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.observationId).toBe(closing);
      expect(rows[0]?.previousBalance).toBe('100');
      expect(rows[0]?.balance).toBe('250');
      expect(rows[0]?.explained).toBe('0');
      expect(rows[0]?.transactionsApplied).toBe(0);
    });
  });

  test('a change a transaction fully explains is not a candidate at all', async () => {
    await withTestDb(async (tx) => {
      const { userId, accountId, tokenId } = await fixture(tx);
      const holding = await makeHolding(tx, { userId, accountId, tokenId });
      await observe(tx, { userId, holdingId: holding.id, balance: '100', observedAt: T0 });
      await makeHoldingTransaction(tx, {
        userId,
        holdingId: holding.id,
        tokenId,
        kind: 'deposit',
        quantity: '150',
        occurredAt: new Date('2026-06-01T12:00:00Z'),
      });
      await observe(tx, { userId, holdingId: holding.id, balance: '250', observedAt: T1 });

      expect(await repo().findGapCandidatesForUser(userId, tx)).toHaveLength(0);
    });
  });

  test('the transaction range is half-open — a tx ON the earlier observation belongs to the interval before', async () => {
    await withTestDb(async (tx) => {
      const { userId, accountId, tokenId } = await fixture(tx);
      const holding = await makeHolding(tx, { userId, accountId, tokenId });
      await observe(tx, { userId, holdingId: holding.id, balance: '100', observedAt: T0 });
      // Stamped exactly on the earlier observation. `(from, to]` excludes it,
      // so this interval is still unexplained — the same rule
      // `BalanceAtTimeService.findTxsInRange` applies, which is why answering
      // a gap must never stamp a row at `from` either.
      await makeHoldingTransaction(tx, {
        userId,
        holdingId: holding.id,
        tokenId,
        kind: 'deposit',
        quantity: '150',
        occurredAt: T0,
      });
      await observe(tx, { userId, holdingId: holding.id, balance: '250', observedAt: T1 });

      const rows = await repo().findGapCandidatesForUser(userId, tx);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.explained).toBe('0');
    });
  });

  test('a tx ON the closing observation IS inside the interval', async () => {
    await withTestDb(async (tx) => {
      const { userId, accountId, tokenId } = await fixture(tx);
      const holding = await makeHolding(tx, { userId, accountId, tokenId });
      await observe(tx, { userId, holdingId: holding.id, balance: '100', observedAt: T0 });
      await makeHoldingTransaction(tx, {
        userId,
        holdingId: holding.id,
        tokenId,
        kind: 'deposit',
        quantity: '150',
        occurredAt: T1,
      });
      await observe(tx, { userId, holdingId: holding.id, balance: '250', observedAt: T1 });

      expect(await repo().findGapCandidatesForUser(userId, tx)).toHaveLength(0);
    });
  });

  test('unpartitioned observations would invent a gap; this query does not', async () => {
    // Two holdings on the same account and token, which production really
    // has — four indistinguishable Tinkoff RUB rows created in the same
    // microsecond. Interleaved in time, a `LAG` without `PARTITION BY
    // holding_id` differences one holding's balance against the other's and
    // reports drift on both. Each holding here is internally consistent, so
    // the correct answer is zero candidates.
    await withTestDb(async (tx) => {
      const { userId, accountId, tokenId } = await fixture(tx);
      const first = await makeHolding(tx, { userId, accountId, tokenId });
      const second = await makeHolding(tx, { userId, accountId, tokenId });

      await observe(tx, { userId, holdingId: first.id, balance: '1000', observedAt: T0 });
      await observe(tx, { userId, holdingId: second.id, balance: '9999', observedAt: T1 });
      await observe(tx, { userId, holdingId: first.id, balance: '1000', observedAt: T2 });

      expect(await repo().findGapCandidatesForUser(userId, tx)).toHaveLength(0);
    });
  });

  test("another user's observations are not returned", async () => {
    await withTestDb(async (tx) => {
      const mine = await fixture(tx);
      const theirs = await fixture(tx);
      const holding = await makeHolding(tx, {
        userId: theirs.userId,
        accountId: theirs.accountId,
        tokenId: theirs.tokenId,
      });
      await observe(tx, {
        userId: theirs.userId,
        holdingId: holding.id,
        balance: '1',
        observedAt: T0,
      });
      await observe(tx, {
        userId: theirs.userId,
        holdingId: holding.id,
        balance: '500',
        observedAt: T1,
      });

      expect(await repo().findGapCandidatesForUser(mine.userId, tx)).toHaveLength(0);
      expect(await repo().findGapCandidatesForUser(theirs.userId, tx)).toHaveLength(1);
    });
  });

  test('the first observation on a holding is never a candidate — it closes no interval', async () => {
    await withTestDb(async (tx) => {
      const { userId, accountId, tokenId } = await fixture(tx);
      const holding = await makeHolding(tx, { userId, accountId, tokenId });
      await observe(tx, { userId, holdingId: holding.id, balance: '5000', observedAt: T0 });
      expect(await repo().findGapCandidatesForUser(userId, tx)).toHaveLength(0);
    });
  });

  test('an unchanged balance with a transaction inside it IS a candidate', async () => {
    // Money in and money out inside one interval leaves both readings equal,
    // so `balance <> previous_balance` alone is not a sound pre-filter: the
    // query also visits every interval a transaction lands in (SC-1319).
    await withTestDb(async (tx) => {
      const { userId, accountId, tokenId } = await fixture(tx);
      const holding = await makeHolding(tx, { userId, accountId, tokenId });
      await observe(tx, { userId, holdingId: holding.id, balance: '100', observedAt: T0 });
      await makeHoldingTransaction(tx, {
        userId,
        holdingId: holding.id,
        tokenId,
        kind: 'deposit',
        quantity: '500',
        occurredAt: new Date('2026-06-01T12:00:00Z'),
      });
      await observe(tx, { userId, holdingId: holding.id, balance: '100', observedAt: T1 });

      const rows = await repo().findGapCandidatesForUser(userId, tx);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.explained).toBe('500');
    });
  });

  test('an answered interval is still returned, carrying its answer', async () => {
    // The reversal test reads its neighbour's drift, and a neighbour may
    // already have been answered. Filtering answered rows out of the query
    // would make one gap's fate depend on whether another had been dealt
    // with — a queue whose contents change when you answer something else.
    await withTestDb(async (tx) => {
      const { userId, accountId, tokenId } = await fixture(tx);
      const holding = await makeHolding(tx, { userId, accountId, tokenId });
      await observe(tx, { userId, holdingId: holding.id, balance: '100', observedAt: T0 });
      const closing = await observe(tx, {
        userId,
        holdingId: holding.id,
        balance: '250',
        observedAt: T1,
      });
      await repo().setGapReview(
        { observationId: closing, userId, answer: 'unknown', source: 'user', reviewedAt: T2 },
        tx
      );

      const rows = await repo().findGapCandidatesForUser(userId, tx);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.gapReview).toBe('unknown');
    });
  });
});

describe('setGapReview', () => {
  test('another user cannot answer an observation that is not theirs', async () => {
    await withTestDb(async (tx) => {
      const mine = await fixture(tx);
      const theirs = await fixture(tx);
      const holding = await makeHolding(tx, {
        userId: theirs.userId,
        accountId: theirs.accountId,
        tokenId: theirs.tokenId,
      });
      const id = await observe(tx, {
        userId: theirs.userId,
        holdingId: holding.id,
        balance: '1',
        observedAt: T0,
      });

      const written = await repo().setGapReview(
        { observationId: id, userId: mine.userId, answer: 'flow', source: 'user', reviewedAt: T1 },
        tx
      );
      expect(written).toBeNull();
    });
  });

  test('an answer can be cleared again — the column does not foreclose a reopen', async () => {
    // "I don't know" is the answer most likely to be given by somebody
    // guessing to clear a row, and a state that can only be entered once is
    // how a wrong answer becomes permanent. No UI offers this yet; the
    // repository can express it so the next person does not add a second
    // write path to get it.
    await withTestDb(async (tx) => {
      const { userId, accountId, tokenId } = await fixture(tx);
      const holding = await makeHolding(tx, { userId, accountId, tokenId });
      const id = await observe(tx, {
        userId,
        holdingId: holding.id,
        balance: '1',
        observedAt: T0,
      });

      await repo().setGapReview(
        { observationId: id, userId, answer: 'unknown', source: 'user', reviewedAt: T1 },
        tx
      );
      const reopened = await repo().setGapReview(
        { observationId: id, userId, answer: null, source: null, reviewedAt: null },
        tx
      );
      expect(reopened?.gapReview).toBeNull();
      expect(reopened?.gapReviewedAt).toBeNull();
    });
  });
});

/**
 * SC-1319: the query reads only pairs that moved or hold a transaction, and
 * each observation's predecessor is stored by a trigger. These cases are the
 * ways a stored predecessor goes stale; the last compares the whole result
 * with the full `LAG` derivation it replaced.
 */
describe('the stored predecessor (SC-1319)', () => {
  test('an observation inserted into the past relinks the one after it', async () => {
    await withTestDb(async (tx) => {
      const { userId, accountId, tokenId } = await fixture(tx);
      const holding = await makeHolding(tx, { userId, accountId, tokenId });
      const closing = await observe(tx, {
        userId,
        holdingId: holding.id,
        balance: '250',
        observedAt: T2,
      });
      await observe(tx, { userId, holdingId: holding.id, balance: '100', observedAt: T0 });
      await observe(tx, { userId, holdingId: holding.id, balance: '100', observedAt: T1 });

      const rows = await repo().findGapCandidatesForUser(userId, tx);
      expect(rows.map((r) => [r.observationId, r.from.toISOString(), r.previousBalance])).toEqual([
        [closing, T1.toISOString(), '100'],
      ]);
    });
  });

  test('several observations of one holding in ONE statement link to each other', async () => {
    await withTestDb(async (tx) => {
      const { userId, accountId, tokenId } = await fixture(tx);
      const holding = await makeHolding(tx, { userId, accountId, tokenId });
      await tx.insert(schema.holdingBalanceObservations).values(
        [
          ['100', T0],
          ['100', T1],
          ['400', T2],
        ].map(([balance, observedAt]) => ({
          userId,
          holdingId: holding.id,
          balance: balance as string,
          observedAt: observedAt as Date,
          source: 'sync-capture',
        }))
      );

      const rows = await repo().findGapCandidatesForUser(userId, tx);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.from).toEqual(T1);
      expect(rows[0]?.previousBalance).toBe('100');
    });
  });

  test('deleting an observation relinks its successor to the one before', async () => {
    await withTestDb(async (tx) => {
      const { userId, accountId, tokenId } = await fixture(tx);
      const holding = await makeHolding(tx, { userId, accountId, tokenId });
      await observe(tx, { userId, holdingId: holding.id, balance: '100', observedAt: T0 });
      const middle = await observe(tx, {
        userId,
        holdingId: holding.id,
        balance: '250',
        observedAt: T1,
      });
      const last = await observe(tx, {
        userId,
        holdingId: holding.id,
        balance: '250',
        observedAt: T2,
      });
      await tx.execute(sql`DELETE FROM holding_balance_observations WHERE id = ${middle}`);

      const rows = await repo().findGapCandidatesForUser(userId, tx);
      expect(rows.map((r) => [r.observationId, r.from.toISOString(), r.previousBalance])).toEqual([
        [last, T0.toISOString(), '100'],
      ]);
    });
  });

  test('moving an observation in time relinks both places it touched', async () => {
    await withTestDb(async (tx) => {
      const { userId, accountId, tokenId } = await fixture(tx);
      const holding = await makeHolding(tx, { userId, accountId, tokenId });
      const first = await observe(tx, {
        userId,
        holdingId: holding.id,
        balance: '100',
        observedAt: T0,
      });
      await observe(tx, { userId, holdingId: holding.id, balance: '250', observedAt: T1 });
      await observe(tx, { userId, holdingId: holding.id, balance: '250', observedAt: T2 });
      // T0 moves past T2: the chain becomes 250 (T1) -> 250 (T2) -> 100 (T3).
      const T3 = new Date('2026-06-04T00:00:00Z');
      await tx.execute(
        sql`UPDATE holding_balance_observations SET observed_at = ${T3.toISOString()} WHERE id = ${first}`
      );

      const rows = await repo().findGapCandidatesForUser(userId, tx);
      expect(rows.map((r) => [r.observationId, r.from.toISOString(), r.previousBalance])).toEqual([
        [first, T2.toISOString(), '250'],
      ]);
    });
  });

  test('matches the full LAG derivation over a seeded mixed history', async () => {
    await withTestDb(async (tx) => {
      const { userId, accountId, tokenId } = await fixture(tx);
      // A deterministic generator, so a failure reproduces.
      let seed = 1319;
      const next = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      const day = (n: number, hour = 0) => new Date(Date.UTC(2026, 0, 1 + n, hour));

      for (let h = 0; h < 4; h++) {
        const holding = await makeHolding(tx, { userId, accountId, tokenId });
        let balance = 100;
        for (let d = 0; d < 40; d++) {
          const roll = next();
          if (roll < 0.15) balance += Math.round(next() * 50) - 25;
          if (roll > 0.85) {
            await makeHoldingTransaction(tx, {
              userId,
              holdingId: holding.id,
              tokenId,
              kind: 'deposit',
              quantity: String(Math.round(next() * 20)),
              occurredAt: day(d, 12),
            });
          }
          if (roll > 0.95) {
            // On the observation's own instant: inside the interval it closes.
            await makeHoldingTransaction(tx, {
              userId,
              holdingId: holding.id,
              tokenId,
              kind: 'withdraw',
              quantity: '-3',
              occurredAt: day(d),
            });
          }
          await observe(tx, {
            userId,
            holdingId: holding.id,
            balance: String(balance),
            observedAt: day(d),
          });
        }
        // Inserted out of order, after the rest.
        await observe(tx, { userId, holdingId: holding.id, balance: '7', observedAt: day(20, 6) });
      }

      const legacy = (await tx.execute(sql`
        WITH paired AS (
          SELECT o.id, o.holding_id, o.observed_at, o.balance,
                 LAG(o.observed_at) OVER w AS previous_observed_at,
                 LAG(o.balance) OVER w AS previous_balance
          FROM holding_balance_observations o
          WHERE o.user_id = ${userId}
          WINDOW w AS (PARTITION BY o.holding_id ORDER BY o.observed_at)
        )
        SELECT paired.id, bridge.explained::text AS explained
        FROM paired
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(t.quantity::numeric), 0) AS explained
          FROM holding_transactions t
          WHERE t.holding_id = paired.holding_id
            AND t.occurred_at > paired.previous_observed_at
            AND t.occurred_at <= paired.observed_at
        ) AS bridge ON TRUE
        WHERE paired.previous_observed_at IS NOT NULL
          AND paired.observed_at > paired.previous_observed_at
          AND (paired.balance::numeric - paired.previous_balance::numeric - bridge.explained) <> 0
        ORDER BY paired.holding_id, paired.observed_at
      `)) as unknown as Array<{ id: string; explained: string }>;

      const rows = await repo().findGapCandidatesForUser(userId, tx);
      // The control: a history that produced no gaps would agree vacuously.
      expect(legacy.length).toBeGreaterThan(10);
      expect(rows.map((r) => [r.observationId, r.explained])).toEqual(
        legacy.map((r) => [r.id, r.explained])
      );
    });
  });
});
