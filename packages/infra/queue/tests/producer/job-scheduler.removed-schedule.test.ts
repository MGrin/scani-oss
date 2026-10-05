/**
 * A schedule that leaves the descriptor list takes its armed occurrence with
 * it. The tests beside this one stub the queue and so show only that the
 * scheduler row is asked to go; whether the job it had parked goes too is the
 * backend's doing, and a job left behind fires into a worker that has no
 * processor for it. So the queue here is the real one.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Container } from 'typedi';
// This workspace cannot depend on @scani/domain (it sits below it), so the
// shared helper is reached the same way the shared test preload is: by path.
import { restoreContainerAfterAll } from '../../../../business/domain/test/helpers/container';
import type { ScheduledJobDescriptor } from '../../src/core/job-descriptor';
import { runQueueMigrations } from '../../src/migrate';
import { JobScheduler } from '../../src/producer/job-scheduler';
import { QueueClient } from '../../src/producer/queue-client';

restoreContainerAfterAll();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must be set — the test preload sets it');

const queueName = `removed-schedule-${crypto.randomUUID()}`;
const queues = new QueueClient();

// Once a year, so no occurrence comes due while the test runs.
const KEPT: ScheduledJobDescriptor = { name: 'kept-job', cron: '0 0 1 1 *' };
const REMOVED: ScheduledJobDescriptor = { name: 'removed-job', cron: '0 0 1 1 *' };

beforeAll(async () => {
  await runQueueMigrations(databaseUrl);
  queues.configure({ connection: databaseUrl, queueName, dlqName: `${queueName}-dlq` });
  Container.set(QueueClient, queues);
});

/** The name of every job waiting or delayed, sorted. */
async function parked(): Promise<string[]> {
  const jobs = await queues.get().getJobs(['waiting', 'delayed']);
  return jobs.map((job) => job.name).sort();
}

async function schedulerKeys(): Promise<string[]> {
  const schedulers = await queues.get().getJobSchedulers();
  return schedulers.map((scheduler) => scheduler.key).sort();
}

afterAll(async () => {
  const queue = queues.get();
  for (const key of await schedulerKeys()) await queue.removeJobScheduler(key);
  await queue.obliterate({ force: true }).catch(() => undefined);
  await queues.close();
});

test('a schedule no descriptor names any more leaves no waiting or delayed job', async () => {
  const scheduler = new JobScheduler();
  await scheduler.upsertAll([KEPT, REMOVED]);
  expect(await parked()).toEqual(['kept-job', 'removed-job']);

  await scheduler.upsertAll([KEPT]);

  expect(await schedulerKeys()).toEqual(['scheduler:kept-job']);
  expect(await parked()).toEqual(['kept-job']);
});
