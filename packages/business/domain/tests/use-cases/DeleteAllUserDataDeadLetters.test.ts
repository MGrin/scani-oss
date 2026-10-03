/**
 * SC-1509. A job that exhausts its retries is COPIED to the dead-letter queue
 * under a new id, and nothing consumes that queue. The deletion purge only
 * looked jobs up by their own id on the main queue, so the copy outlived the
 * account: production held one, a `file-import` payload, for an account that
 * had been deleted a day earlier.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as schema from '@scani/db/schema';
import { QueueClient, runQueueMigrations } from '@scani/queue';
import { Container } from 'typedi';
import { DeleteAllUserDataUseCase } from '../../src/use-cases/DeleteAllUserDataUseCase';
import { restoreContainerAfterAll } from '../../test/helpers/container';

restoreContainerAfterAll();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must be set — the test preload sets it');

const queueName = `sc1509-${randomUUID()}`;
const dlqName = `${queueName}-dlq`;
/** What the use case resolves. */
const jobs = new QueueClient();
/** The same dead-letter queue, opened without going through the code under test. */
const deadLetters = new QueueClient();

beforeAll(async () => {
  await runQueueMigrations(databaseUrl);
  jobs.configure({ connection: databaseUrl, queueName, dlqName });
  deadLetters.configure({ connection: databaseUrl, queueName: dlqName });
  Container.set(QueueClient, jobs);
});

afterAll(async () => {
  await deadLetters
    .get()
    .obliterate({ force: true })
    .catch(() => undefined);
  await deadLetters.close();
  await jobs.close();
});

/** The shape `WorkerClient` writes when a job's retries are exhausted. */
async function deadLetter(originalJobId: string, data: Record<string, unknown>): Promise<string> {
  const job = await deadLetters.get().add('file-import', {
    originalJobId,
    originalName: 'file-import',
    data,
    failedReason: 'parser gave up',
    attemptsMade: 3,
    timestamp: Date.now(),
  });
  if (!job.id) throw new Error('the dead-letter queue returned no id');
  return job.id;
}

const present = async (id: string) => Boolean(await deadLetters.get().getJob(id));

test('a deleted account’s dead-lettered jobs are removed with it', async () => {
  const deleted = randomUUID();
  const other = randomUUID();
  const knownJobId = `file-import_${deleted}_${randomUUID()}`;

  const byUser = await deadLetter(`file-import_${deleted}_${randomUUID()}`, {
    userId: deleted,
    r2Key: `uploads/${deleted}/statement.csv`,
  });
  // A payload that names no user is still theirs when `user_jobs` knew the job.
  const byJobId = await deadLetter(knownJobId, { r2Key: 'uploads/statement.csv' });
  const someoneElses = await deadLetter(`file-import_${other}_${randomUUID()}`, { userId: other });

  // CONTROL: all three are readable before the purge, or absence below proves nothing.
  expect([await present(byUser), await present(byJobId), await present(someoneElses)]).toEqual([
    true,
    true,
    true,
  ]);

  await new DeleteAllUserDataUseCase().purgeAfterCommit(
    deleted,
    new Map([[schema.userJobs, [knownJobId]]])
  );

  expect(await present(byUser)).toBe(false);
  expect(await present(byJobId)).toBe(false);
  expect(await present(someoneElses)).toBe(true);
});

test('an account with no recorded jobs still has its dead letters removed', async () => {
  const deleted = randomUUID();
  const id = await deadLetter(`file-import_${deleted}_${randomUUID()}`, { userId: deleted });

  await new DeleteAllUserDataUseCase().purgeAfterCommit(deleted, new Map());

  expect(await present(id)).toBe(false);
});
