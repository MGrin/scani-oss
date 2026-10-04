import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from '@scani/db';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import {
  DEAD_LETTER_ALARM,
  DEAD_LETTER_MAX_AGE_MS,
  DEAD_LETTER_RENOTIFY_MS,
  FAILED_JOB_MAX_AGE_MS,
} from '@scani/jobs';
import { QueueClient, runQueueMigrations, WorkerClient } from '@scani/queue';
import { sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { __test_runDeadLetterProbe } from '../../src/processors/dlq-depth-probe';

restoreContainerAfterAll();

/**
 * SC-1545. Nothing consumes the dead-letter queue, so the 14-day age its
 * entries were written with never applied: production held one for 35 days.
 * And the probe spoke only at a depth of 50, so five entries, four of them the
 * payloads of accounts that no longer existed, were known to nobody.
 *
 * The queue and the alarm ledger are real here. The claim is that state
 * survives between probes, and a stand-in would prove that about itself.
 */

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must be set — the test preload sets it');

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NO_DEPTH_ALARM = 50;
const PAYLOAD_MARKER = 'payload-must-not-be-reported';

const queueName = `sc1545-${randomUUID()}`;
const dlqName = `${queueName}-dlq`;
const queues = new QueueClient();
const workers: WorkerClient[] = [];

async function clearAlarmRows(): Promise<void> {
  await getDb().execute(sql`delete from operator_alarms where alarm = ${DEAD_LETTER_ALARM}`);
}

async function emptyQueues(): Promise<void> {
  for (const queue of [queues.get(), queues.deadLetter()]) {
    for (const job of await queue.getJobs(['waiting', 'delayed', 'failed', 'completed'])) {
      await job.remove();
    }
  }
}

beforeAll(async () => {
  await runQueueMigrations(databaseUrl);
  queues.configure({ connection: databaseUrl, queueName, dlqName });
  Container.set(QueueClient, queues);
});

beforeEach(async () => {
  await clearAlarmRows();
  await emptyQueues();
});

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close(true).catch(() => undefined);
});

afterAll(async () => {
  await clearAlarmRows();
  for (const queue of [queues.get(), queues.deadLetter()]) {
    await queue.obliterate({ force: true }).catch(() => undefined);
  }
  await queues.close();
});

/** The shape `WorkerClient` writes when a job's retries are exhausted. */
async function deadLetter(name: string, failedReason: string): Promise<string> {
  const job = await queues.deadLetter().add(name, {
    originalJobId: `${name}-original`,
    originalName: name,
    data: { note: PAYLOAD_MARKER },
    failedReason,
    attemptsMade: 2,
    timestamp: Date.now(),
  });
  return job.id as string;
}

function harness() {
  const captured: Array<{ message: string; tags?: Record<string, string> }> = [];
  const captureException = (err: unknown, tags?: Record<string, string>) => {
    captured.push({ message: err instanceof Error ? err.message : String(err), tags });
  };
  const started = Date.now();
  const probeAfter = (ms: number, depthThreshold = NO_DEPTH_ALARM) =>
    __test_runDeadLetterProbe(depthThreshold, new Date(started + ms), { captureException });
  return { captured, probeAfter };
}

const deadLetterIds = async () =>
  (await queues.deadLetter().getJobs(['waiting'])).map((job) => job.id).sort();

describe('dead-letter probe', () => {
  test('a new dead letter is reported once, by name and reason, never by payload', async () => {
    const { captured, probeAfter } = harness();
    await deadLetter('document-parse', 'the provider refused the file');

    await probeAfter(MINUTE);
    await probeAfter(16 * MINUTE);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.tags?.kind).toBe('dead-letter-alert');
    expect(captured[0]?.tags?.transition).toBe('entered');
    expect(captured[0]?.message).toContain('document-parse');
    expect(captured[0]?.message).toContain('the provider refused the file');
    expect(captured[0]?.message).not.toContain(PAYLOAD_MARKER);
  });

  test('CONTROL: an empty queue reports nothing', async () => {
    const { captured, probeAfter } = harness();

    await probeAfter(MINUTE);

    expect(captured).toEqual([]);
  });

  test('a reason that spans lines is reported on one', async () => {
    const { captured, probeAfter } = harness();
    await deadLetter('document-parse', 'upstream HTTP 400: {\n  "message": "bad file"\n}');

    await probeAfter(MINUTE);

    expect(captured[0]?.message).toContain('upstream HTTP 400: { "message": "bad file" }');
    expect(captured[0]?.message).not.toContain('\n');
  });

  test('one nobody triaged is stated again after the re-notify window, as its own news', async () => {
    const { captured, probeAfter } = harness();
    await deadLetter('file-import', 'still here');

    await probeAfter(MINUTE);
    await probeAfter(DEAD_LETTER_RENOTIFY_MS + 2 * MINUTE);

    expect(captured.map((c) => c.tags?.transition)).toEqual(['entered', 'restated']);
  });

  test('once one is removed, the next dead letter is news again', async () => {
    const { captured, probeAfter } = harness();
    const first = await deadLetter('file-import', 'first');
    await probeAfter(MINUTE);

    await (await queues.deadLetter().getJob(first))?.remove();
    await deadLetter('wallet-import', 'second');
    await probeAfter(16 * MINUTE);

    expect(captured).toHaveLength(2);
    expect(captured[1]?.message).toContain('wallet-import');
    expect(captured[1]?.message).not.toContain('file-import');
  });

  test('a dead letter is removed once it is older than its age, and not a day before', async () => {
    const { probeAfter } = harness();
    const id = await deadLetter('db-backup', 'old news');

    await probeAfter(DEAD_LETTER_MAX_AGE_MS - DAY);
    expect(await deadLetterIds()).toEqual([id]);

    await probeAfter(DEAD_LETTER_MAX_AGE_MS + DAY);
    expect(await deadLetterIds()).toEqual([]);
  });

  test('the depth alarm still fires at its threshold, beside the per-entry one', async () => {
    const { captured, probeAfter } = harness();
    await deadLetter('file-import', 'one');
    await deadLetter('file-import', 'two');

    await probeAfter(MINUTE, 2);

    expect(captured.map((c) => c.tags?.kind).sort()).toEqual([
      'dead-letter-alert',
      'dlq-depth-alert',
    ]);
  });

  test('a failed row on the main queue is removed once it is older than its age, and not before', async () => {
    const { probeAfter } = harness();
    const worker = new WorkerClient();
    workers.push(worker);
    worker.configure({ connection: databaseUrl, queueName, dlqName });
    worker.register({
      descriptor: { name: 'always-fails' },
      process: async () => {
        throw new Error('synthetic failure');
      },
    } as never);
    const running = await worker.start();
    running.on('error', () => undefined);
    await running.waitUntilReady();
    await queues.get().add('always-fails', {}, { attempts: 1 });
    const failed = async () => (await queues.get().getJobs(['failed'])).length;
    const deadline = Date.now() + 10_000;
    while ((await failed()) === 0 && Date.now() < deadline) await Bun.sleep(25);
    expect(await failed()).toBe(1);

    await probeAfter(FAILED_JOB_MAX_AGE_MS - DAY);
    expect(await failed()).toBe(1);

    await probeAfter(FAILED_JOB_MAX_AGE_MS + DAY);
    expect(await failed()).toBe(0);
  });
});
