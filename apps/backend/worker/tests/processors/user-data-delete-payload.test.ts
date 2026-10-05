import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as schema from '@scani/db/schema';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { DeleteAllUserDataUseCase } from '@scani/domain/use-cases';
import { USER_DATA_DELETE } from '@scani/jobs';
import { QueueClient, runQueueMigrations, WorkerClient } from '@scani/queue';
import { Container } from 'typedi';

restoreContainerAfterAll();

/**
 * SC-1545. The deletion purge runs INSIDE the `user-data-delete` job, and that
 * job names the user twice: in its payload and in its id. It is active while
 * the purge looks for it, and BullMQ refuses to remove a job another worker
 * holds, so the purge cannot take it. What decides whether the row outlives
 * the user is the job's own retention.
 *
 * SC-1560. Told its own job's id, the purge leaves that job alone instead of
 * trying twice and warning twice on every deletion.
 *
 * The queue and the worker are real: the claim is about what BullMQ does to an
 * active job, and a stand-in would answer for itself.
 */

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must be set — the test preload sets it');

const queueName = `sc1545-delete-${randomUUID()}`;
const dlqName = `${queueName}-dlq`;
const queues = new QueueClient();

beforeAll(async () => {
  await runQueueMigrations(databaseUrl);
  queues.configure({ connection: databaseUrl, queueName, dlqName });
  Container.set(QueueClient, queues);
});

afterAll(async () => {
  for (const queue of [queues.get(), queues.deadLetter()]) {
    await queue.obliterate({ force: true }).catch(() => undefined);
  }
  await queues.close();
});

const REMOVAL_FAILED = 'Failed to remove BullMQ payload during user-data-delete (non-fatal)';

/** Every row on the main queue that names the user, in its payload or in its id. */
async function rowsNaming(userId: string): Promise<string[]> {
  return (await queues.get().getJobs())
    .filter(
      (job) =>
        (job.data as { userId?: unknown } | null)?.userId === userId ||
        String(job.id).includes(userId)
    )
    .map((job) => job.name)
    .sort();
}

/**
 * One deletion through a real worker. `namesItself` is whether the job hands
 * the purge its own id, which is the only thing the two tests below vary.
 */
async function runDeletion({ namesItself }: { namesItself: boolean }) {
  const deleted = randomUUID();
  const other = randomUUID();

  const useCase = new DeleteAllUserDataUseCase();
  // `logger` is private so the use case owns its component name.
  const { logger } = useCase as unknown as {
    logger: { warn: (context: unknown, message: string) => void };
  };
  const warned = spyOn(logger, 'warn').mockImplementation(() => {});

  const worker = new WorkerClient();
  worker.configure({ connection: databaseUrl as string, queueName, dlqName });
  worker.register({
    descriptor: { name: USER_DATA_DELETE.name },
    // What `DeleteAllUserDataUseCase.execute` does once its transaction has
    // committed: `user_jobs` recorded this job's own id.
    process: async (job: { id?: string; name: string; data: { userId: string } }) => {
      if (job.name !== USER_DATA_DELETE.name) return { success: true };
      await useCase.purgeAfterCommit(
        job.data.userId,
        new Map([[schema.userJobs, job.id ? [job.id] : []]]),
        namesItself ? job.id : undefined
      );
      return { success: true };
    },
  } as never);

  // CONTROL: another user's job stays, or an emptied queue would pass this.
  await queues.get().add('manual-holdings-create', { userId: other });
  // A job naming the deleted user that is NOT the running one, held back so no
  // worker takes it: the purge must still remove it.
  await queues.get().add('holding-price-update', { userId: deleted }, { delay: 600_000 });
  const payload = { userId: deleted, requestId: randomUUID() };
  await queues.get().add(USER_DATA_DELETE.name, payload, {
    ...USER_DATA_DELETE.defaultOpts,
    jobId: USER_DATA_DELETE.computeJobId(payload),
  });
  expect(await rowsNaming(deleted)).toEqual(['holding-price-update', USER_DATA_DELETE.name].sort());

  const running = await worker.start();
  running.on('error', () => undefined);
  const settled: string[] = [];
  running.on('completed', (job) => {
    if (job.name === USER_DATA_DELETE.name && job.data.userId === deleted) {
      settled.push('completed');
    }
  });
  running.on('failed', (job) => {
    if (job?.name === USER_DATA_DELETE.name && job.data.userId === deleted) settled.push('failed');
  });
  const deadline = Date.now() + 15_000;
  while (settled.length === 0 && Date.now() < deadline) await Bun.sleep(25);
  await Bun.sleep(500);
  await worker.close(true).catch(() => undefined);

  const failedRemovals = warned.mock.calls.filter(([, message]) => message === REMOVAL_FAILED);
  warned.mockRestore();
  return {
    settled,
    failedRemovals: failedRemovals.length,
    left: await rowsNaming(deleted),
    otherUsers: await rowsNaming(other),
  };
}

test('a deletion that names itself warns about nothing and leaves no row naming the user', async () => {
  const run = await runDeletion({ namesItself: true });

  expect(run.settled).toEqual(['completed']);
  expect(run.failedRemovals).toBe(0);
  expect(run.left).toEqual([]);
  expect(run.otherUsers).toEqual(['manual-holdings-create']);
}, 30_000);

// The spy can see the warning, and a job the purge is not told about is still
// attempted: once by the id `user_jobs` recorded, once by the payload match.
test('CONTROL: a purge that is not told its own job still tries it, and warns', async () => {
  const run = await runDeletion({ namesItself: false });

  expect(run.settled).toEqual(['completed']);
  expect(run.failedRemovals).toBe(2);
  expect(run.left).toEqual([]);
}, 30_000);
