import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import { UserJobRepository } from '../../src/repositories/UserJobRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeUser } from '../../test/helpers/factories';

const repo = () => new UserJobRepository();
const NAME = 'portfolio-history-backfill';

async function enqueue(tx: DatabaseTransaction, userId: string, jobId: string) {
  await repo().insertEnqueued(
    { jobId, userId, jobName: NAME, payloadSummary: {}, attemptsAllowed: 2 },
    tx
  );
}

// A lock-held retry re-arms under the same BullMQ job id once the previous one
// finished. The row kept the FIRST instance's start, so on production two
// instant skips and one 19-minute run read as a full rebuild from 23:29 to
// 00:29 overlapping another until 01:03 (SC-1707). Worse since SC-1607: a new
// job reusing a cancelled id could never be marked active, so it ran unseen.
describe('a reused job id starts a fresh row (SC-1707)', () => {
  test('an enqueue after the row finished resets it', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const jobId = `${NAME}_${user.id}_lock-held-retry`;
      await enqueue(tx, user.id, jobId);
      await repo().markActive(jobId, 1, tx);
      await repo().markCompleted(jobId, {}, tx);

      await enqueue(tx, user.id, jobId);

      const row = await repo().findOneMine(user.id, jobId, tx);
      expect(row?.state).toBe('queued');
      expect(row?.startedAt).toBeNull();
      expect(row?.finishedAt).toBeNull();
      expect(row?.progress).toBe(0);
    });
  });

  test('a new job under a cancelled id is seen running', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const jobId = `${NAME}_${user.id}_mutation-1`;
      await enqueue(tx, user.id, jobId);
      await repo().markActive(jobId, 1, tx);
      await repo().markCancelled(user.id, jobId, tx);

      await enqueue(tx, user.id, jobId);
      await repo().markActive(jobId, 1, tx);

      const row = await repo().findOneMine(user.id, jobId, tx);
      expect(row?.state).toBe('active');
      expect(row?.failureReason).toBeNull();
      expect(row?.deadAt).toBeNull();
    });
  });

  test('control: an enqueue while the row is still pending leaves it alone', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const jobId = `${NAME}_${user.id}_pending`;
      await enqueue(tx, user.id, jobId);
      await repo().markActive(jobId, 1, tx);
      const before = await repo().findOneMine(user.id, jobId, tx);

      await enqueue(tx, user.id, jobId);

      const after = await repo().findOneMine(user.id, jobId, tx);
      expect(after?.state).toBe('active');
      expect(after?.startedAt?.getTime()).toBe(before?.startedAt?.getTime());
    });
  });
});

describe('the in-flight check can skip the asking job (SC-1707)', () => {
  test('a rebuild finishing reads past its own row, and no other', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const own = `${NAME}_${user.id}_own`;
      await enqueue(tx, user.id, own);
      await repo().markActive(own, 1, tx);

      expect(await repo().findInFlightByName(user.id, NAME, tx, own)).toBeNull();
      expect((await repo().findInFlightByName(user.id, NAME, tx))?.jobId).toBe(own);

      const other = `${NAME}_${user.id}_other`;
      await enqueue(tx, user.id, other);
      expect((await repo().findInFlightByName(user.id, NAME, tx, own))?.jobId).toBe(other);
    });
  });
});
