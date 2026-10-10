import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createPostgresBackend, type Job, type PostgresQueueBackend, Queue } from 'bullmq';
import { WorkerClient } from '../../src/consumer/worker-client';
import { runQueueMigrations } from '../../src/migrate';

/**
 * SC-1567. A deploy that deletes a scheduled job runs the orphan loop, whose
 * `removeJobScheduler` deletes the scheduler's next occurrence only while it is
 * still `delayed` (bullmq's Postgres `remove_job_scheduler` says so in its own
 * comment). An occurrence already promoted to waiting survives, and the new
 * worker, which has no processor for that name, threw `No processor registered`
 * on it through every retry into failed and the dead-letter queue.
 *
 * The control is an unknown USER job: it has no scheduler behind it, so a
 * missing processor there is a real defect and must still fail.
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

function openQueue(name: string): PgQueue {
  const queue = new Queue(
    name,
    { connection: { connectionString: databaseUrl!, schema: 'bullmq' } } as never,
    createPostgresBackend
  ) as unknown as PgQueue;
  queues.push(queue);
  return queue;
}

async function startWorker(queueName: string): Promise<{ hookCalls: string[] }> {
  const hookCalls: string[] = [];
  const client = new WorkerClient();
  clients.push(client);
  client.configure({ connection: databaseUrl!, queueName, dlqName: `${queueName}-dlq` });
  client.register({
    descriptor: { name: 'kept-job', cron: '0 * * * *' },
    process: async (_job: Job) => undefined,
  } as never);
  client.onTerminalFailure((_job, err) => {
    hookCalls.push(err instanceof Error ? err.message : String(err));
  });
  const worker = await client.start();
  worker.on('error', () => undefined);
  await worker.waitUntilReady();
  return { hookCalls };
}

async function settle(queue: PgQueue, jobId: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await queue.getJobState(jobId);
    if (state === 'completed' || state === 'failed') return state;
    await Bun.sleep(50);
  }
  return String(await queue.getJobState(jobId));
}

// The terminal-failure hook runs on the worker's 'failed' event, which fires after the
// job's state already reads failed — so a loaded box can show the state first.
async function hookCallsAfter(hookCalls: string[]): Promise<string[]> {
  const deadline = Date.now() + 5_000;
  while (hookCalls.length === 0 && Date.now() < deadline) await Bun.sleep(25);
  return hookCalls;
}

describe('a promoted occurrence of a removed schedule (SC-1567)', () => {
  test('completes as a no-op instead of failing into the dead-letter queue', async () => {
    const queueName = `sc1567-${crypto.randomUUID()}`;
    const queue = openQueue(queueName);
    await queue.upsertJobScheduler(
      'scheduler:retired-job',
      { every: 3_600_000 },
      { name: 'retired-job', data: {}, opts: { attempts: 1 } }
    );
    for (const job of await queue.getJobs(['delayed'])) await job.promote();
    await queue.removeJobScheduler('scheduler:retired-job');

    // The precondition the ticket describes: the scheduler is gone, its
    // promoted occurrence is not.
    expect(await queue.getJobSchedulers()).toEqual([]);
    const [survivor] = await queue.getJobs(['waiting']);
    expect(survivor?.name).toBe('retired-job');

    const { hookCalls } = await startWorker(queueName);
    expect(await settle(queue, String(survivor?.id))).toBe('completed');
    expect(hookCalls).toEqual([]);
  });

  test('CONTROL: an unknown user job still fails, because nothing retired it', async () => {
    const queueName = `sc1567-${crypto.randomUUID()}`;
    const queue = openQueue(queueName);
    const job = await queue.add('mystery-job', { userId: 'u' }, { attempts: 1 });

    const { hookCalls } = await startWorker(queueName);
    expect(await settle(queue, String(job.id))).toBe('failed');
    expect(await hookCallsAfter(hookCalls)).toEqual([
      "No processor registered for job 'mystery-job'",
    ]);
  });
});
