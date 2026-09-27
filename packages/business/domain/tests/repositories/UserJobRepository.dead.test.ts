import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { UserJobRepository } from '../../src/repositories/UserJobRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeUser } from '../../test/helpers/factories';

/**
 * SC-153 — the write that says "the queue has given up".
 *
 * `markFailed` fires on every failed attempt, so before this the row could not
 * distinguish a retry that is coming from one that never will. The behaviours
 * that matter and are easy to regress: it must land on a row that is already
 * `failed` (unlike every other lifecycle write, which is guarded to
 * non-terminal states), it must also rescue a row still sitting at `queued`,
 * and the first terminal write must win so a cancellation cannot be relabelled.
 */

const repo = () => new UserJobRepository();

async function seed(
  tx: Parameters<Parameters<typeof withTestDb>[0]>[0],
  userId: string,
  jobId: string,
  attemptsAllowed = 3
) {
  await repo().insertEnqueued(
    { jobId, userId, jobName: 'wallet-import', payloadSummary: {}, attemptsAllowed },
    tx
  );
}

describe('UserJobRepository.markDead', () => {
  test('stamps a row that is already failed from its last attempt', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const jobId = `wallet-import_${user.id}_dead-1`;
      await seed(tx, user.id, jobId);
      await repo().markActive(jobId, 3, tx);
      await repo().markFailed(jobId, 'upstream 502', { attemptsMade: 3, attemptsAllowed: 3 }, tx);

      const marked = await repo().markDead(
        jobId,
        {
          reason: 'retries_exhausted',
          error: 'upstream 502',
          attemptsMade: 3,
          attemptsAllowed: 3,
        },
        tx
      );

      expect(marked).toBe(true);
      const row = await repo().findOneMine(user.id, jobId, tx);
      expect(row?.state).toBe('failed');
      expect(row?.deadAt).toBeInstanceOf(Date);
      expect(row?.failureReason).toBe('retries_exhausted');
      // The per-attempt message is the more specific one; the terminal write
      // must not flatten it.
      expect(row?.error).toBe('upstream 502');
    });
  });

  test('rescues a row still sitting at queued', async () => {
    // The payload-validation path: the processor throws before any lifecycle
    // event fires, so nothing ever moved the row off `queued` and the user saw
    // a job that looked like it was about to start, forever.
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const jobId = `wallet-import_${user.id}_dead-2`;
      await seed(tx, user.id, jobId);

      await repo().markDead(
        jobId,
        {
          reason: 'retries_exhausted',
          error: 'Invalid payload for job',
          attemptsMade: 3,
          attemptsAllowed: 3,
        },
        tx
      );

      const row = await repo().findOneMine(user.id, jobId, tx);
      expect(row?.state).toBe('failed');
      expect(row?.deadAt).toBeInstanceOf(Date);
      expect(row?.error).toContain('Invalid payload');
      expect(row?.finishedAt).toBeInstanceOf(Date);
    });
  });

  test('the first terminal write wins — a cancellation is not relabelled', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const jobId = `wallet-import_${user.id}_dead-3`;
      await seed(tx, user.id, jobId);
      await repo().markActive(jobId, 1, tx);
      expect(await repo().markCancelled(user.id, jobId, tx)).toBe(true);

      // The worker's own terminal event lands a moment later.
      const marked = await repo().markDead(
        jobId,
        {
          reason: 'retries_exhausted',
          error: 'worker shut down',
          attemptsMade: 1,
          attemptsAllowed: 3,
        },
        tx
      );

      expect(marked).toBe(false);
      const row = await repo().findOneMine(user.id, jobId, tx);
      expect(row?.failureReason).toBe('cancelled');
      expect(row?.error).toBe('Cancelled by user');
    });
  });

  test('markCancelled stamps dead itself, and never asks the user about it', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const jobId = `wallet-import_${user.id}_dead-4`;
      await seed(tx, user.id, jobId);
      await repo().markCancelled(user.id, jobId, tx);

      const row = await repo().findOneMine(user.id, jobId, tx);
      expect(row?.deadAt).toBeInstanceOf(Date);
      expect(row?.failureReason).toBe('cancelled');
      // action_taken_at is what keeps it out of the review feed.
      expect(row?.actionTakenAt).toBeInstanceOf(Date);
    });
  });

  test('a retried job stops being dead', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const jobId = `wallet-import_${user.id}_dead-5`;
      await seed(tx, user.id, jobId);
      await repo().markDead(
        jobId,
        { reason: 'retries_exhausted', error: 'boom', attemptsMade: 3, attemptsAllowed: 3 },
        tx
      );

      await repo().markRequeued(jobId, tx);

      const row = await repo().findOneMine(user.id, jobId, tx);
      expect(row?.state).toBe('queued');
      expect(row?.deadAt).toBeNull();
      expect(row?.failureReason).toBeNull();
      // And it leaves the feed with them.
      expect(await repo().findDeadUnacknowledged(user.id, 50, tx)).toHaveLength(0);
    });
  });
});

describe('UserJobRepository.findDeadUnacknowledged', () => {
  test('returns dead jobs the user has not acted on, newest death first', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const older = `wallet-import_${user.id}_feed-1`;
      const newer = `wallet-import_${user.id}_feed-2`;
      await seed(tx, user.id, older);
      await seed(tx, user.id, newer);
      await repo().markDead(
        older,
        { reason: 'retries_exhausted', error: 'a', attemptsMade: 3, attemptsAllowed: 3 },
        tx
      );
      // `dead_at` comes from `new Date()`, which is millisecond-resolution:
      // back-to-back calls in a test tie where two real failures never would.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await repo().markDead(
        newer,
        { reason: 'unrecoverable', error: 'b', attemptsMade: 1, attemptsAllowed: 3 },
        tx
      );

      const rows = await repo().findDeadUnacknowledged(user.id, 50, tx);
      expect(rows.map((r) => r.jobId)).toEqual([newer, older]);
    });
  });

  test('a merely-failed job is not in it', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const jobId = `wallet-import_${user.id}_feed-3`;
      await seed(tx, user.id, jobId);
      await repo().markActive(jobId, 1, tx);
      await repo().markFailed(jobId, 'transient', { attemptsMade: 1, attemptsAllowed: 3 }, tx);

      expect(await repo().findDeadUnacknowledged(user.id, 50, tx)).toHaveLength(0);
    });
  });

  test('dismissing one clears it without deleting the record', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const jobId = `wallet-import_${user.id}_feed-4`;
      await seed(tx, user.id, jobId);
      await repo().markDead(
        jobId,
        { reason: 'retries_exhausted', error: 'boom', attemptsMade: 3, attemptsAllowed: 3 },
        tx
      );

      await repo().markActionTaken(user.id, jobId, 'discarded', tx);

      expect(await repo().findDeadUnacknowledged(user.id, 50, tx)).toHaveLength(0);
      // The run, its error and its verdict are all still there to read.
      const row = await repo().findOneMine(user.id, jobId, tx);
      expect(row?.error).toBe('boom');
      expect(row?.failureReason).toBe('retries_exhausted');
    });
  });

  test("another user's dead job is not in this user's feed", async () => {
    await withTestDb(async (tx) => {
      const mine = await makeUser(tx);
      const theirs = await makeUser(tx);
      const jobId = `wallet-import_${theirs.id}_feed-5`;
      await seed(tx, theirs.id, jobId);
      await repo().markDead(
        jobId,
        { reason: 'retries_exhausted', error: 'boom', attemptsMade: 3, attemptsAllowed: 3 },
        tx
      );

      expect(await repo().findDeadUnacknowledged(mine.id, 50, tx)).toHaveLength(0);
      expect(await repo().findDeadUnacknowledged(theirs.id, 50, tx)).toHaveLength(1);
    });
  });
});

describe('UserJobRepository.findDeadUnacknowledged — a later success retires it', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const T0 = new Date('2026-07-10T01:00:00Z');

  async function run(
    tx: Parameters<Parameters<typeof withTestDb>[0]>[0],
    userId: string,
    jobId: string,
    jobName: string,
    createdAt: Date
  ) {
    await repo().insertEnqueued(
      { jobId, userId, jobName, payloadSummary: {}, attemptsAllowed: 3 },
      tx
    );
    await tx.update(schema.userJobs).set({ createdAt }).where(eq(schema.userJobs.jobId, jobId));
  }

  async function deadRun(
    tx: Parameters<Parameters<typeof withTestDb>[0]>[0],
    userId: string,
    jobId: string,
    jobName: string,
    createdAt: Date
  ) {
    await run(tx, userId, jobId, jobName, createdAt);
    await repo().markDead(
      jobId,
      {
        reason: 'retries_exhausted',
        error: 'Bybit retCode=131002',
        attemptsMade: 3,
        attemptsAllowed: 3,
      },
      tx
    );
  }

  async function completedRun(
    tx: Parameters<Parameters<typeof withTestDb>[0]>[0],
    userId: string,
    jobId: string,
    jobName: string,
    createdAt: Date
  ) {
    await run(tx, userId, jobId, jobName, createdAt);
    await repo().markCompleted(jobId, { imported: 3 }, tx);
  }

  test('a later completed run of the same job, for the same user, retires it', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await deadRun(tx, user.id, 'ti-dead', 'transaction-import', T0);
      await completedRun(tx, user.id, 'ti-ok', 'transaction-import', new Date(T0.getTime() + DAY));

      expect(await repo().findDeadUnacknowledged(user.id, 50, tx)).toHaveLength(0);
    });
  });

  test('a dead job with NO later success stays in the feed', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await deadRun(tx, user.id, 'phb-dead', 'portfolio-history-backfill', T0);

      const rows = await repo().findDeadUnacknowledged(user.id, 50, tx);
      expect(rows.map((r) => r.jobId)).toEqual(['phb-dead']);
    });
  });

  test('an EARLIER success says nothing about a failure that followed it', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await completedRun(
        tx,
        user.id,
        'ti-ok-before',
        'transaction-import',
        new Date(T0.getTime() - DAY)
      );
      await deadRun(tx, user.id, 'ti-dead-after', 'transaction-import', T0);

      const rows = await repo().findDeadUnacknowledged(user.id, 50, tx);
      expect(rows.map((r) => r.jobId)).toEqual(['ti-dead-after']);
    });
  });

  test("another user's later success is not evidence about this user's integration", async () => {
    await withTestDb(async (tx) => {
      const mine = await makeUser(tx);
      const theirs = await makeUser(tx);
      await deadRun(tx, mine.id, 'ti-dead-mine', 'transaction-import', T0);
      await completedRun(
        tx,
        theirs.id,
        'ti-ok-theirs',
        'transaction-import',
        new Date(T0.getTime() + DAY)
      );

      const rows = await repo().findDeadUnacknowledged(mine.id, 50, tx);
      expect(rows.map((r) => r.jobId)).toEqual(['ti-dead-mine']);
    });
  });

  test('a later success of a DIFFERENT job does not retire it', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await deadRun(tx, user.id, 'ti-dead-other', 'transaction-import', T0);
      await completedRun(tx, user.id, 'wi-ok', 'wallet-import', new Date(T0.getTime() + DAY));

      const rows = await repo().findDeadUnacknowledged(user.id, 50, tx);
      expect(rows.map((r) => r.jobId)).toEqual(['ti-dead-other']);
    });
  });
});
