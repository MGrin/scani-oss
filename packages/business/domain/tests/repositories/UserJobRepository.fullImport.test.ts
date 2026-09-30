import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import { UserJobRepository } from '../../src/repositories/UserJobRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeUser } from '../../test/helpers/factories';

// Constructed directly rather than through the Container: see the note in
// `UserJobRepository.test.ts`.
const repo = () => new UserJobRepository();

let seq = 0;
async function importJob(
  tx: DatabaseTransaction,
  userId: string,
  summary: { accountId: string; source: string; since?: string },
  outcome: { complete: boolean } | 'failed'
): Promise<void> {
  const jobId = `transaction-import_${userId}_${++seq}`;
  // `finished_at` orders the verdicts and is stamped in JS; one transaction's
  // rows can otherwise share a millisecond.
  await Bun.sleep(3);
  await repo().insertEnqueued(
    { jobId, userId, jobName: 'transaction-import', payloadSummary: summary, attemptsAllowed: 1 },
    tx
  );
  if (outcome === 'failed') {
    await repo().markFailed(jobId, 'boom', { attemptsMade: 1, attemptsAllowed: 1 }, tx);
    return;
  }
  await repo().markCompleted(jobId, { status: 'ok', hasCompleteTxHistory: outcome.complete }, tx);
}

describe('UserJobRepository.findFullImportHistory (SC-1427)', () => {
  test('reads the latest completed full import as claimed, and ignores windows for it', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await importJob(tx, user.id, { accountId: 'acc-a', source: 'etherscan' }, { complete: true });
      // A window afterwards claims nothing either way, and must not hide it.
      await importJob(
        tx,
        user.id,
        { accountId: 'acc-a', source: 'etherscan', since: '2026-09-01T00:00:00.000Z' },
        { complete: false }
      );

      const history = await repo().findFullImportHistory(['acc-a'], 'etherscan', tx);
      expect(history.get('acc-a')).toMatchObject({ claimed: true, lastWindowFailureAt: null });
      expect(history.get('acc-a')?.lastFullAttemptAt).toBeInstanceOf(Date);
      expect((await repo().findFullImportHistory(['acc-a'], 'kraken-api', tx)).size).toBe(0);
    });
  });

  test('a later full import that did not claim wins, and a failed one states nothing', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await importJob(
        tx,
        user.id,
        { accountId: 'acc-b', source: 'kraken-api' },
        { complete: true }
      );
      await importJob(
        tx,
        user.id,
        { accountId: 'acc-b', source: 'kraken-api' },
        { complete: false }
      );
      await importJob(tx, user.id, { accountId: 'acc-b', source: 'kraken-api' }, 'failed');

      const history = await repo().findFullImportHistory(['acc-b'], 'kraken-api', tx);
      expect(history.get('acc-b')?.claimed).toBe(false);
    });
  });

  test('dates the newest failed window, which retracts every claim on the account', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await importJob(tx, user.id, { accountId: 'acc-c', source: 'etherscan' }, { complete: true });
      await importJob(
        tx,
        user.id,
        { accountId: 'acc-c', source: 'etherscan', since: '2026-09-01T00:00:00.000Z' },
        'failed'
      );

      const history = await repo().findFullImportHistory(['acc-c'], 'etherscan', tx);
      expect(history.get('acc-c')?.lastWindowFailureAt).toBeInstanceOf(Date);
    });
  });

  test('leaves an account that never had a full import', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await importJob(
        tx,
        user.id,
        { accountId: 'acc-d', source: 'etherscan', since: '2026-09-01T00:00:00.000Z' },
        'failed'
      );
      expect((await repo().findFullImportHistory(['acc-d'], 'etherscan', tx)).size).toBe(0);
    });
  });
});
