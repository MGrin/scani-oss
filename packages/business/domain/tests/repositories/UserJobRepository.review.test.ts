import { describe, expect, test } from 'bun:test';
import { UserJobRepository } from '../../src/repositories/UserJobRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeUser } from '../../test/helpers/factories';

// Constructed directly, NOT via the Container — see the note in
// `UserJobRepository.test.ts`: a processor test's partial stub is
// process-global and would otherwise be what this file resolves.
const repo = () => new UserJobRepository();

describe('UserJobRepository.findPendingReview', () => {
  test('returns only reviewable kinds that have not been acted on', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);

      await repo().insertEnqueued(
        {
          jobId: 'j-screenshot',
          userId: user.id,
          jobName: 'screenshot-parse',
          payloadSummary: {},
          attemptsAllowed: 3,
        },
        tx
      );
      await repo().markCompleted('j-screenshot', { holdings: [] }, tx);

      await repo().insertEnqueued(
        {
          jobId: 'j-price',
          userId: user.id,
          jobName: 'holding-price-update',
          payloadSummary: {},
          attemptsAllowed: 3,
        },
        tx
      );
      await repo().markCompleted('j-price', {}, tx);

      await repo().insertEnqueued(
        {
          jobId: 'j-acted',
          userId: user.id,
          jobName: 'file-import',
          payloadSummary: {},
          attemptsAllowed: 3,
        },
        tx
      );
      await repo().markCompleted('j-acted', {}, tx);
      await repo().markActionTaken(user.id, 'j-acted', 'imported', tx);

      const ids = (await repo().findPendingReview(user.id, 50, tx)).map((j) => j.jobId);

      expect(ids).toContain('j-screenshot');
      expect(ids).not.toContain('j-price');
      expect(ids).not.toContain('j-acted');
    });
  });

  test('excludes jobs that have not completed', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await repo().insertEnqueued(
        {
          jobId: 'j-running',
          userId: user.id,
          jobName: 'screenshot-parse',
          payloadSummary: {},
          attemptsAllowed: 3,
        },
        tx
      );
      const ids = (await repo().findPendingReview(user.id, 50, tx)).map((j) => j.jobId);
      expect(ids).not.toContain('j-running');
    });
  });

  test('never returns another user rows', async () => {
    await withTestDb(async (tx) => {
      const mine = await makeUser(tx);
      const theirs = await makeUser(tx);

      await repo().insertEnqueued(
        {
          jobId: 'j-theirs',
          userId: theirs.id,
          jobName: 'screenshot-parse',
          payloadSummary: {},
          attemptsAllowed: 3,
        },
        tx
      );
      await repo().markCompleted('j-theirs', {}, tx);

      expect(await repo().findPendingReview(mine.id, 50, tx)).toHaveLength(0);
    });
  });
});

// SC-138: before `review_outcome` existed, `action_taken_at` was written
// only by a successful import — so a parse the user did not want had no
// way out of the queue, and once one was stamped nothing could say which
// of the two things had happened.
describe('UserJobRepository.markActionTaken — outcomes', () => {
  test('discarding clears the review queue without importing', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await repo().insertEnqueued(
        {
          jobId: 'j-discard',
          userId: user.id,
          jobName: 'screenshot-parse',
          payloadSummary: {},
          attemptsAllowed: 3,
        },
        tx
      );
      await repo().markCompleted('j-discard', {}, tx);
      expect(await repo().findPendingReview(user.id, 50, tx)).toHaveLength(1);

      await repo().markActionTaken(user.id, 'j-discard', 'discarded', tx);

      expect(await repo().findPendingReview(user.id, 50, tx)).toHaveLength(0);
      const row = await repo().findOneMine(user.id, 'j-discard', tx);
      expect(row?.reviewOutcome).toBe('discarded');
    });
  });

  test('defaults to imported, and a later discard cannot rewrite it', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await repo().insertEnqueued(
        {
          jobId: 'j-imported',
          userId: user.id,
          jobName: 'file-import',
          payloadSummary: {},
          attemptsAllowed: 3,
        },
        tx
      );
      await repo().markCompleted('j-imported', {}, tx);

      await repo().markActionTaken(user.id, 'j-imported', undefined, tx);
      await repo().markActionTaken(user.id, 'j-imported', 'discarded', tx);

      const row = await repo().findOneMine(user.id, 'j-imported', tx);
      expect(row?.reviewOutcome).toBe('imported');
    });
  });
});
