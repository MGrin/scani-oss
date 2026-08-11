import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { UserJobRepository } from '../../src/repositories/UserJobRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeUser } from '../../test/helpers/factories';

const repo = () => Container.get(UserJobRepository);

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
      await repo().markActionTaken(user.id, 'j-acted', tx);

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
