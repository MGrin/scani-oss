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
): Promise<{ hookCalls: string[]; failures: number }> {
  const queueName = `sc1381-${crypto.randomUUID()}`;
  const queue = new Queue(
    queueName,
    { connection: { connectionString: databaseUrl!, schema: 'bullmq' } } as never,
    createPostgresBackend
  ) as unknown as PgQueue;
  queues.push(queue);

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
  return { hookCalls, failures };
}

describe('terminal-failure hooks and a by-design refusal (SC-1381)', () => {
  test('an UnrecoverableError ends the job without reaching the hook', async () => {
    const { hookCalls, failures } = await runFailingJob(
      () =>
        userFacing(new UnrecoverableError('This file is larger than 8 MB. Upload a smaller file.')),
      3
    );
    expect(failures).toBe(1);
    expect(hookCalls).toEqual([]);
  });

  test('CONTROL: an ordinary error that exhausts its attempts reaches the hook once', async () => {
    const { hookCalls } = await runFailingJob(() => new Error('upstream exploded'), 1);
    expect(hookCalls).toEqual(['upstream exploded']);
  });
});
