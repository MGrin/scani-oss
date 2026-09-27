import { describe, expect, test } from 'bun:test';
import { UserJobRepository } from '../../src/repositories/UserJobRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeUser } from '../../test/helpers/factories';

const repo = () => new UserJobRepository();

describe('a completed job is not dead', () => {
  test('markCompleted clears the death stamp, and the review feed drops it', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const jobId = `portfolio-history-backfill_${user.id}_revived`;
      await repo().insertEnqueued(
        {
          jobId,
          userId: user.id,
          jobName: 'portfolio-history-backfill',
          payloadSummary: {},
          attemptsAllowed: 2,
        },
        tx
      );
      await repo().markActive(jobId, 2, tx);
      await repo().markFailed(
        jobId,
        'over the memory budget',
        { attemptsMade: 2, attemptsAllowed: 2 },
        tx
      );
      await repo().markDead(
        jobId,
        {
          reason: 'retries_exhausted',
          error: 'over the memory budget',
          attemptsMade: 2,
          attemptsAllowed: 2,
        },
        tx
      );

      // The control: while it is dead, Review asks about it.
      const whileDead = await repo().findDeadUnacknowledged(user.id, 50, tx);
      expect(whileDead.map((j) => j.jobId)).toContain(jobId);

      // Requeued the way a direct queue retry does it — state moves back to a
      // non-terminal one, but nothing clears the stamp on the way.
      await repo().markActive(jobId, 3, tx);
      await repo().markCompleted(jobId, { daysComputed: 70 }, tx);

      const row = await repo().findOneMine(user.id, jobId, tx);
      expect(row?.state).toBe('completed');
      expect(row?.deadAt).toBeNull();
      expect(row?.failureReason).toBeNull();

      const after = await repo().findDeadUnacknowledged(user.id, 50, tx);
      expect(after.map((j) => j.jobId)).not.toContain(jobId);
    });
  });

  test('a job that is still dead keeps its stamp and its place in Review', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const jobId = `wallet-import_${user.id}_still-dead`;
      await repo().insertEnqueued(
        {
          jobId,
          userId: user.id,
          jobName: 'wallet-import',
          payloadSummary: {},
          attemptsAllowed: 1,
        },
        tx
      );
      await repo().markActive(jobId, 1, tx);
      await repo().markFailed(jobId, 'upstream 502', { attemptsMade: 1, attemptsAllowed: 1 }, tx);
      await repo().markDead(
        jobId,
        { reason: 'retries_exhausted', error: 'upstream 502', attemptsMade: 1, attemptsAllowed: 1 },
        tx
      );

      const row = await repo().findOneMine(user.id, jobId, tx);
      expect(row?.deadAt).not.toBeNull();
      const feed = await repo().findDeadUnacknowledged(user.id, 50, tx);
      expect(feed.map((j) => j.jobId)).toContain(jobId);
    });
  });
});
