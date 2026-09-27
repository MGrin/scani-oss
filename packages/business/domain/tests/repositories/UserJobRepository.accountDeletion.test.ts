import { describe, expect, test } from 'bun:test';
import { UserJobRepository } from '../../src/repositories/UserJobRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeUser } from '../../test/helpers/factories';

/**
 * SC-1276. The browser signs out when an account deletion is QUEUED, so a job
 * that then fails leaves an account its owner believes is gone. A completed one
 * leaves no row at all (it cascades with `users`), so any account-scoped delete
 * row still standing is one that did not finish, and the next sign-in must be
 * able to find it. The data-only delete and a dismissed failure are the
 * controls: a finder that returned any delete row would pass the first case.
 */

const repo = () => new UserJobRepository();

type Tx = Parameters<Parameters<typeof withTestDb>[0]>[0];

async function seed(tx: Tx, userId: string, jobId: string, deleteAccount: boolean) {
  await repo().insertEnqueued(
    {
      jobId,
      userId,
      jobName: 'user-data-delete',
      payloadSummary: deleteAccount ? { deleteAccount: true } : {},
      attemptsAllowed: 1,
    },
    tx
  );
}

describe('UserJobRepository.findUnfinishedAccountDeletion', () => {
  test('finds a failed account deletion, with the words written for its owner', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await seed(tx, user.id, 'del-1', true);
      await repo().markFailed(
        'del-1',
        'constraint',
        { attemptsMade: 1, attemptsAllowed: 1, userFacingError: 'Contact support' },
        tx
      );
      const row = await repo().findUnfinishedAccountDeletion(user.id, tx);
      expect(row).toMatchObject({
        jobId: 'del-1',
        state: 'failed',
        userFacingError: 'Contact support',
      });
    });
  });

  test('finds one still queued', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await seed(tx, user.id, 'del-2', true);
      expect((await repo().findUnfinishedAccountDeletion(user.id, tx))?.state).toBe('queued');
    });
  });

  test('ignores a data-only delete and a dismissed failure', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await seed(tx, user.id, 'data-1', false);
      await repo().markFailed('data-1', 'x', { attemptsMade: 1, attemptsAllowed: 1 }, tx);
      await seed(tx, user.id, 'del-3', true);
      await repo().markFailed('del-3', 'x', { attemptsMade: 1, attemptsAllowed: 1 }, tx);
      await repo().dismissFailed(user.id, 'del-3', tx);
      expect(await repo().findUnfinishedAccountDeletion(user.id, tx)).toBeNull();
    });
  });
});
