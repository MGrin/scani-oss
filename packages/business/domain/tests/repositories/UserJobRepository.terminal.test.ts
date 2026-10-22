import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import { UserJobRepository } from '../../src/repositories/UserJobRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeUser } from '../../test/helpers/factories';

const repo = () => new UserJobRepository();

async function seed(tx: DatabaseTransaction, userId: string, jobId: string) {
  await repo().insertEnqueued(
    {
      jobId,
      userId,
      jobName: 'portfolio-history-backfill',
      payloadSummary: {},
      attemptsAllowed: 2,
    },
    tx
  );
}

// On production a cancelled history rebuild kept running, and each progress
// write put its row back to 'progress'. Returns reads that row as a rebuild in
// flight, so it was withheld for 16 hours with nothing left to finish (SC-1607).
describe('a terminal job row stays terminal', () => {
  test('progress after a cancel leaves the row cancelled', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const jobId = `portfolio-history-backfill_${user.id}_cancelled`;
      await seed(tx, user.id, jobId);
      await repo().markActive(jobId, 1, tx);
      await repo().updateProgress(jobId, 0.3, tx);
      expect(await repo().markCancelled(user.id, jobId, tx)).toBe(true);

      await repo().updateProgress(jobId, 0.74, tx);

      const row = await repo().findOneMine(user.id, jobId, tx);
      expect(row?.state).toBe('failed');
      expect(row?.failureReason).toBe('cancelled');
      expect(await repo().findInFlightByName(user.id, 'portfolio-history-backfill', tx)).toBeNull();
    });
  });

  test('a cancelled job is not revived by its next attempt starting', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const jobId = `portfolio-history-backfill_${user.id}_cancelled-retry`;
      await seed(tx, user.id, jobId);
      await repo().markActive(jobId, 1, tx);
      await repo().markCancelled(user.id, jobId, tx);

      await repo().markActive(jobId, 2, tx);

      expect((await repo().findOneMine(user.id, jobId, tx))?.state).toBe('failed');
    });
  });

  test('progress after completion leaves the row completed', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const jobId = `portfolio-history-backfill_${user.id}_completed`;
      await seed(tx, user.id, jobId);
      await repo().markActive(jobId, 1, tx);
      await repo().markCompleted(jobId, {}, tx);

      await repo().updateProgress(jobId, 0.5, tx);

      const row = await repo().findOneMine(user.id, jobId, tx);
      expect(row?.state).toBe('completed');
      expect(row?.progress).toBe(1);
    });
  });

  test('control: progress on a running job still moves it', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const jobId = `portfolio-history-backfill_${user.id}_running`;
      await seed(tx, user.id, jobId);
      await repo().markActive(jobId, 1, tx);

      await repo().updateProgress(jobId, 0.4, tx);

      const row = await repo().findOneMine(user.id, jobId, tx);
      expect(row?.state).toBe('progress');
      expect(row?.progress).toBeCloseTo(0.4);
    });
  });
});
