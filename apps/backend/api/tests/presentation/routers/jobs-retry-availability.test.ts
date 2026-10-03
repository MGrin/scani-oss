import { describe, expect, test } from 'bun:test';
import type * as schema from '@scani/db/schema';
import { UserJobRepository } from '@scani/domain/repositories';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { QueueClient } from '@scani/queue';
import { Container } from 'typedi';
import { jobsRouter } from '../../../src/presentation/routers/jobs';
import { buildAuthedContext } from '../../helpers/test-caller';

restoreContainerAfterAll();

/**
 * SC-1527. A manual-holdings job died as unrecoverable — "Failed — won't
 * retry" — and its page still offered Retry. The worker's verdict was that
 * another attempt changes nothing, and the server answered `available: true`
 * because it only ever asked the queue whether a re-run was POSSIBLE.
 *
 * The exception is a wallet import that died because every chain it probed
 * was unreachable: the worker stops it early rather than spend its attempts
 * against an outage, and a retry later is exactly what can work. The worker
 * records that as `source_unavailable`, so the line is drawn on the reason it
 * wrote, never on the words of the error.
 *
 * Both stubs answer as the real ones would for a job BullMQ still holds in
 * `failed`, so the only thing that varies between cases is the row.
 */

const USER_ID = 'user-sc1527';
const user = { id: USER_ID, email: 'sc1527@example.test' } as typeof schema.users.$inferSelect;

function deadRow(jobName: string, failureReason: string): schema.UserJob {
  return {
    jobId: `${jobName}_${USER_ID}_1`,
    userId: USER_ID,
    jobName,
    state: 'failed',
    attemptsMade: 1,
    attemptsAllowed: 3,
    deadAt: new Date('2026-10-02T09:00:09Z'),
    failureReason,
    error: 'internal',
    userFacingError: null,
  } as unknown as schema.UserJob;
}

function callerFor(row: schema.UserJob) {
  const retried: string[] = [];
  Container.set(UserJobRepository, {
    findOneMine: async () => row,
    markRequeued: async () => undefined,
  } as unknown as UserJobRepository);
  Container.set(QueueClient, {
    get: () => ({
      getJob: async (jobId: string) => ({
        getState: async () => 'failed',
        retry: async () => {
          retried.push(jobId);
        },
      }),
    }),
  } as unknown as QueueClient);
  return { caller: jobsRouter.createCaller(buildAuthedContext(user)), retried };
}

describe('Retry is offered only where retrying can help (SC-1527)', () => {
  test('an unrecoverable failure is not offered a retry', async () => {
    const { caller } = callerFor(deadRow('manual-holdings-create', 'unrecoverable'));
    const job = await caller.getMine({ jobId: 'manual-holdings-create_user-sc1527_1' });
    expect(job.retry).toEqual({ available: false, reason: 'unrecoverable' });
  });

  test('and a stale page pressing Retry anyway is refused, not re-run', async () => {
    const { caller, retried } = callerFor(deadRow('manual-holdings-create', 'unrecoverable'));
    await expect(caller.retry({ jobId: 'manual-holdings-create_user-sc1527_1' })).rejects.toThrow(
      /another attempt will not fix/
    );
    expect(retried).toEqual([]);
  });

  test('a wallet import stopped by an outage keeps its Retry', async () => {
    const { caller, retried } = callerFor(deadRow('wallet-import', 'source_unavailable'));
    const job = await caller.getMine({ jobId: 'wallet-import_user-sc1527_1' });
    expect(job.retry).toEqual({ available: true, queueHasJob: true });
    await caller.retry({ jobId: 'wallet-import_user-sc1527_1' });
    expect(retried).toEqual(['wallet-import_user-sc1527_1']);
  });

  test('CONTROL: a job that spent its attempts keeps its Retry', async () => {
    const { caller } = callerFor(deadRow('exchange-import', 'retries_exhausted'));
    const job = await caller.getMine({ jobId: 'exchange-import_user-sc1527_1' });
    expect(job.retry).toEqual({ available: true, queueHasJob: true });
  });
});
