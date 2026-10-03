import { describe, expect, test } from 'bun:test';
import { UserJobRepository } from '../../src/repositories/UserJobRepository';
import { restoreContainerAfterAll } from '../../test/helpers/container';
import { withTestDb } from '../../test/helpers/db';
import { makeUser } from '../../test/helpers/factories';

restoreContainerAfterAll();

/**
 * SC-1527. /jobs badged a screenshot parse "Completed" while its own page said
 * "Failed · Files read 0 of 1": the page derives the outcome from `result`, and
 * the list row carries no `result` (SC-155). So the row carries the outcome's
 * COUNTS instead — two numbers, not the payload they were read from.
 */

// Constructed directly for the reason `UserJobRepository.test.ts` gives.
const repo = () => new UserJobRepository();

async function seed(
  tx: Parameters<typeof makeUser>[0],
  userId: string,
  jobName: string,
  result: unknown
): Promise<string> {
  const jobId = `${jobName}_${userId}_${crypto.randomUUID().slice(0, 8)}`;
  await repo().insertEnqueued(
    { jobId, userId, jobName, payloadSummary: {}, attemptsAllowed: 1 },
    tx
  );
  await repo().markCompleted(jobId, result, tx);
  return jobId;
}

describe('findMine carries the outcome a completed run produced (SC-1527)', () => {
  test('a parse that read none of its files lists as 0 succeeded, 1 failed', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const jobId = await seed(tx, user.id, 'screenshot-parse', {
        files: [{ r2Key: 'k', success: false, error: 'unreadable' }],
        summary: { totalFiles: 1, successCount: 0, failureCount: 1 },
      });

      const [listed] = await repo().findMine(user.id, {}, tx);
      expect(listed?.jobId).toBe(jobId);
      expect(listed?.outcome).toEqual({ succeeded: 0, failed: 1 });
      expect('result' in (listed as object)).toBe(false);
    });
  });

  test('a manual create counts the holdings that errored', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await seed(tx, user.id, 'manual-holdings-create', {
        accountId: 'a',
        holdings: [{ id: 'h1', error: 'no price' }],
      });

      const [listed] = await repo().findMine(user.id, {}, tx);
      expect(listed?.outcome).toEqual({ succeeded: 0, failed: 1 });
    });
  });

  test('CONTROL: a job with no outcome to read lists none', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await seed(tx, user.id, 'wallet-import', { chains: [], chainsDetected: 0 });

      const [listed] = await repo().findMine(user.id, {}, tx);
      expect(listed?.outcome).toBeNull();
    });
  });
});
