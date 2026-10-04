import { afterAll, beforeAll, expect, test } from 'bun:test';
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

/** Every row on the main queue that names the user, in its payload or in its id. */
async function rowsNaming(userId: string): Promise<string[]> {
  return (await queues.get().getJobs())
    .filter(
      (job) =>
        (job.data as { userId?: unknown } | null)?.userId === userId ||
        String(job.id).includes(userId)
    )
    .map((job) => job.name);
}

test('a finished deletion leaves no queue row naming the deleted user', async () => {
  const deleted = randomUUID();
  const other = randomUUID();

  const worker = new WorkerClient();
  worker.configure({ connection: databaseUrl, queueName, dlqName });
  worker.register({
    descriptor: { name: USER_DATA_DELETE.name },
    // What `DeleteAllUserDataUseCase.execute` does once its transaction has
    // committed: `user_jobs` recorded this job's own id.
    process: async (job: { id?: string; data: { userId: string } }) => {
      await new DeleteAllUserDataUseCase().purgeAfterCommit(
        job.data.userId,
        new Map([[schema.userJobs, job.id ? [job.id] : []]])
      );
      return { success: true };
    },
  } as never);

  // CONTROL: another user's job stays, or an emptied queue would pass this.
  await queues.get().add('manual-holdings-create', { userId: other });
  const payload = { userId: deleted, requestId: randomUUID() };
  await queues.get().add(USER_DATA_DELETE.name, payload, {
    ...USER_DATA_DELETE.defaultOpts,
    jobId: USER_DATA_DELETE.computeJobId(payload),
  });
  expect(await rowsNaming(deleted)).toEqual([USER_DATA_DELETE.name]);

  const running = await worker.start();
  running.on('error', () => undefined);
  const settled: string[] = [];
  running.on('completed', (job) => {
    if (job.name === USER_DATA_DELETE.name) settled.push('completed');
  });
  running.on('failed', (job) => {
    if (job?.name === USER_DATA_DELETE.name) settled.push('failed');
  });
  const deadline = Date.now() + 15_000;
  while (settled.length === 0 && Date.now() < deadline) await Bun.sleep(25);
  await Bun.sleep(500);
  await worker.close(true).catch(() => undefined);

  expect(settled).toEqual(['completed']);
  expect(await rowsNaming(deleted)).toEqual([]);
  expect(await rowsNaming(other)).toEqual(['manual-holdings-create']);
}, 30_000);
