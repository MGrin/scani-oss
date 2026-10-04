import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  createPostgresBackend,
  type Job,
  type PostgresQueueBackend,
  Queue,
  UnrecoverableError,
} from 'bullmq';
import { userFacing } from '../../src';
import { WorkerClient } from '../../src/consumer/worker-client';
import { runQueueMigrations } from '../../src/migrate';

/**
 * SC-1381. The worker's Sentry capture is a terminal-failure hook, and the only
 * thing keeping a by-design refusal from paging is `WorkerClient` skipping its
 * hooks for an `UnrecoverableError`. An oversized upload (SC-1363) is exactly
 * that refusal: it paged once before #1994 made it unrecoverable. Nothing
 * asserted the skip, so dropping it would page on every user-facing refusal
 * with no test going red. The retries-exhausted case is the control: it must
 * still reach the hook, or a skip would pass here by never firing at all.
 *
 * SC-1545 is the same skip for the dead-letter queue, which had a hole the
 * hook did not: its gate read the attempt counter, and BullMQ counts the
 * failing attempt before the listener runs. A refusal on a job's last allowed
 * attempt was therefore dead-lettered, which for a single-attempt job is every
 * refusal. So the refusal is asserted at one attempt as well as at three.
 */

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must be set — the test preload sets it');

type PgQueue = Queue<unknown, unknown, string, unknown, unknown, string, PostgresQueueBackend>;

const clients: WorkerClient[] = [];
const queues: PgQueue[] = [];

beforeAll(async () => {
  await runQueueMigrations(databaseUrl);
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close(true).catch(() => undefined);
  for (const q of queues.splice(0)) {
    await q.obliterate({ force: true }).catch(() => undefined);
    await q.close();
  }
});

async function runFailingJob(
  fail: () => Error,
  attempts: number
): Promise<{ hookCalls: string[]; failures: number; deadLetters: number }> {
  const queueName = `sc1381-${crypto.randomUUID()}`;
  const queue = new Queue(
    queueName,
    { connection: { connectionString: databaseUrl!, schema: 'bullmq' } } as never,
    createPostgresBackend
  ) as unknown as PgQueue;
  queues.push(queue);
  // Read through a queue of its own: the depth is what the code under test wrote.
  const deadLetterQueue = new Queue(
    `${queueName}-dlq`,
    { connection: { connectionString: databaseUrl!, schema: 'bullmq' } } as never,
    createPostgresBackend
  ) as unknown as PgQueue;
  queues.push(deadLetterQueue);

  const hookCalls: string[] = [];
  let failures = 0;
  const client = new WorkerClient();
  clients.push(client);
  client.configure({ connection: databaseUrl!, queueName, dlqName: `${queueName}-dlq` });
  client.register({
    descriptor: { name: 'refusal' },
    process: async (_job: Job) => {
      throw fail();
    },
  } as never);
  client.onTerminalFailure((_job, err) => {
    hookCalls.push(err instanceof Error ? err.message : String(err));
  });
  const worker = await client.start();
  worker.on('error', () => undefined);
  worker.on('failed', () => {
    failures += 1;
  });
  await worker.waitUntilReady();

  await queue.add('refusal', {}, { attempts });
  const deadline = Date.now() + 10_000;
  while (failures === 0 && Date.now() < deadline) await Bun.sleep(25);
  // Long enough for a retry to start, and for the hook, which runs after
  // `markDead` in the same handler, to have run.
  await Bun.sleep(1_000);
  const counts = await deadLetterQueue.getJobCounts('waiting', 'delayed', 'active');
  const deadLetters = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return { hookCalls, failures, deadLetters };
}

describe('terminal-failure hooks and a by-design refusal (SC-1381)', () => {
  test('an UnrecoverableError ends the job without reaching the hook', async () => {
    const { hookCalls, failures, deadLetters } = await runFailingJob(
      () =>
        userFacing(new UnrecoverableError('This file is larger than 8 MB. Upload a smaller file.')),
      3
    );
    expect(failures).toBe(1);
    expect(hookCalls).toEqual([]);
    expect(deadLetters).toBe(0);
  });

  test('an UnrecoverableError on a single-attempt job is not dead-lettered either', async () => {
    const { hookCalls, failures, deadLetters } = await runFailingJob(
      () => userFacing(new UnrecoverableError('The account this was for could not be found.')),
      1
    );
    expect(failures).toBe(1);
    expect(hookCalls).toEqual([]);
    expect(deadLetters).toBe(0);
  });

  test('CONTROL: an ordinary error that exhausts its attempts reaches the hook once, and is dead-lettered', async () => {
    const { hookCalls, deadLetters } = await runFailingJob(() => new Error('upstream exploded'), 1);
    expect(hookCalls).toEqual(['upstream exploded']);
    expect(deadLetters).toBe(1);
  });
});
