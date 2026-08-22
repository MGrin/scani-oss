import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
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
    // so `balance <> previous_balance` is not a sound pre-filter and the
    // query deliberately does not use one.
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
