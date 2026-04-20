import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { withTestDb } from '../../test/helpers/db';
import { makeUser } from '../../test/helpers/factories';
import { UserJobRepository } from './UserJobRepository';

// Realistic DB-backed coverage for UserJobRepository — this is the durable
// mirror of every user-initiated BullMQ job, and every method here gets
// exercised by the worker's processor wrapper (hot path). The pgEnum cast
// trap (enum-column `eq()` bindings) and state-machine transitions are
// the two most regression-prone behaviours; explicit tests for both.

const repo = () => Container.get(UserJobRepository);

describe('UserJobRepository', () => {
  test('insertEnqueued persists a new row with state=queued', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await repo().insertEnqueued(
        {
          jobId: `wallet-import_${user.id}_test-1`,
          userId: user.id,
          jobName: 'wallet-import',
          payloadSummary: { chain: 'auto' },
          attemptsAllowed: 3,
        },
        tx
      );
      const row = await repo().findOneMine(user.id, `wallet-import_${user.id}_test-1`, tx);
      expect(row?.state).toBe('queued');
      expect(row?.jobName).toBe('wallet-import');
      expect(row?.attemptsAllowed).toBe(3);
      expect(row?.progress).toBe(0);
    });
  });

  test('insertEnqueued is idempotent on jobId (BullMQ dedupe safety)', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const args = {
        jobId: `wallet-import_${user.id}_test-2`,
        userId: user.id,
        jobName: 'wallet-import',
        payloadSummary: { chain: 'auto' },
        attemptsAllowed: 1,
      };
      await repo().insertEnqueued(args, tx);
      // Second call must NOT throw (onConflictDoNothing) — double-clicks
      // and queue.add retries land here.
      await repo().insertEnqueued(args, tx);
      const row = await repo().findOneMine(args.userId, args.jobId, tx);
      expect(row).not.toBeNull();
    });
  });

  test('markActive / updateProgress / markCompleted drive state transitions', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const jobId = `wallet-import_${user.id}_test-3`;
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
      let row = await repo().findOneMine(user.id, jobId, tx);
      expect(row?.state).toBe('active');
      expect(row?.startedAt).not.toBeNull();
      expect(row?.attemptsMade).toBe(1);

      await repo().updateProgress(jobId, 0.5, tx);
      row = await repo().findOneMine(user.id, jobId, tx);
      expect(row?.state).toBe('progress');
      expect(row?.progress).toBe(0.5);

      await repo().markCompleted(jobId, { holdingsCreated: 7 }, tx);
      row = await repo().findOneMine(user.id, jobId, tx);
      expect(row?.state).toBe('completed');
      expect(row?.progress).toBe(1);
      expect(row?.finishedAt).not.toBeNull();
      expect(row?.result).toEqual({ holdingsCreated: 7 });
    });
  });

  test('markFailed records error + attempt counters', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const jobId = `wallet-import_${user.id}_test-4`;
      await repo().insertEnqueued(
        {
          jobId,
          userId: user.id,
          jobName: 'wallet-import',
          payloadSummary: {},
          attemptsAllowed: 3,
        },
        tx
      );
      await repo().markFailed(jobId, 'RPC timeout', { attemptsMade: 2, attemptsAllowed: 3 }, tx);
      const row = await repo().findOneMine(user.id, jobId, tx);
      expect(row?.state).toBe('failed');
      expect(row?.error).toBe('RPC timeout');
      expect(row?.attemptsMade).toBe(2);
      expect(row?.finishedAt).not.toBeNull();
    });
  });

  test('markFailed truncates oversized error messages', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const jobId = `wallet-import_${user.id}_test-5`;
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
      const giant = 'x'.repeat(10_000);
      await repo().markFailed(jobId, giant, { attemptsMade: 1, attemptsAllowed: 1 }, tx);
      const row = await repo().findOneMine(user.id, jobId, tx);
      // Keep row compact; full error stays in worker logs / Sentry.
      expect(row?.error?.length).toBeLessThanOrEqual(4000);
    });
  });

  test('findMine orders newest first, filters by state', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      for (let i = 0; i < 3; i++) {
        await repo().insertEnqueued(
          {
            jobId: `wallet-import_${user.id}_seq-${i}`,
            userId: user.id,
            jobName: 'wallet-import',
            payloadSummary: { seq: i },
            attemptsAllowed: 1,
          },
          tx
        );
      }
      await repo().markCompleted(`wallet-import_${user.id}_seq-1`, {}, tx);

      const all = await repo().findMine(user.id, {}, tx);
      expect(all.length).toBeGreaterThanOrEqual(3);
      // Most recent first.
      expect(all[0]!.createdAt >= all[all.length - 1]!.createdAt).toBe(true);

      // pgEnum binding test — raw `'completed'` string must bind as the enum
      // (if Drizzle ever loses the pgEnum wrapper, Postgres will fail this
      // filter with "operator does not exist: user_job_state = text").
      const completed = await repo().findMine(user.id, { state: 'completed' }, tx);
      expect(completed.every((r) => r.state === 'completed')).toBe(true);
      expect(completed.length).toBe(1);
    });
  });

  test('findOneMine scopes by userId (no cross-user leaks)', async () => {
    await withTestDb(async (tx) => {
      const userA = await makeUser(tx);
      const userB = await makeUser(tx);
      const jobId = `wallet-import_${userA.id}_iso`;
      await repo().insertEnqueued(
        {
          jobId,
          userId: userA.id,
          jobName: 'wallet-import',
          payloadSummary: {},
          attemptsAllowed: 1,
        },
        tx
      );
      expect(await repo().findOneMine(userA.id, jobId, tx)).not.toBeNull();
      expect(await repo().findOneMine(userB.id, jobId, tx)).toBeNull();
    });
  });

  test('countActive reflects queued+active+progress only', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await repo().insertEnqueued(
        {
          jobId: `wallet-import_${user.id}_q`,
          userId: user.id,
          jobName: 'wallet-import',
          payloadSummary: {},
          attemptsAllowed: 1,
        },
        tx
      );
      await repo().insertEnqueued(
        {
          jobId: `wallet-import_${user.id}_c`,
          userId: user.id,
          jobName: 'wallet-import',
          payloadSummary: {},
          attemptsAllowed: 1,
        },
        tx
      );
      await repo().markCompleted(`wallet-import_${user.id}_c`, {}, tx);

      const n = await repo().countActive(user.id, tx);
      expect(n).toBe(1);
    });
  });
});
