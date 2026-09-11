import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  createPostgresBackend,
  type Job,
  type PostgresQueueBackend,
  Queue,
  type Worker,
} from 'bullmq';
import { Pool } from 'pg';
import { WorkerClient } from '../../src/consumer/worker-client';
import { runQueueMigrations } from '../../src/migrate';

/**
 * SC-1146. A deploy restarts the worker, and a job longer than the drain budget
 * is interrupted. Production showed such a job left `active` with an expired
 * lock and recovered only by the stalled check — which spends BullMQ's stall
 * budget (`maxStalledCount`, default 1). A second deploy during the re-run
 * failed the job outright with "job stalled more than allowable limit".
 *
 * A graceful restart must not spend that budget; a crash must. The two are
 * what separates a long job from a poison one, so both are asserted here, on
 * the real Postgres backend.
 *
 * Time is skipped rather than waited for. Production's lock is 30s and its
 * stalled interval 600s (SC-963, not lowered here), so `skipStallClock`
 * expires only the DEAD worker's locks and runs the stalled check twice
 * through the NEW worker — the mark pass and the sweep pass the check needs —
 * with that worker's real options, `maxStalledCount` included.
 */

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must be set — the test preload sets it');

const SCHEMA = 'bullmq';
const pool = new Pool({ connectionString: databaseUrl, max: 1 });

type PgWorker = Worker<unknown, unknown, string, PostgresQueueBackend>;
type PgQueue = Queue<unknown, unknown, string, unknown, unknown, string, PostgresQueueBackend>;

const clients: WorkerClient[] = [];
const queues: PgQueue[] = [];
const hung: Array<() => void> = [];

beforeAll(async () => {
  await runQueueMigrations(databaseUrl);
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close(true).catch(() => undefined);
  for (const release of hung.splice(0)) release();
  for (const q of queues.splice(0)) {
    await q.obliterate({ force: true }).catch(() => undefined);
    await q.close();
  }
});

afterAll(async () => {
  await pool.end();
});

function makeQueue(name: string): PgQueue {
  const q = new Queue(
    name,
    { connection: { connectionString: databaseUrl!, schema: SCHEMA } } as never,
    createPostgresBackend
  ) as unknown as PgQueue;
  queues.push(q);
  return q;
}

/** A long job: every run blocks until the test ends, except run `completesOn`. */
function longJob(completesOn: number) {
  const state = { starts: 0 };
  const processor = {
    descriptor: { name: 'long-job' },
    process: async (_job: Job) => {
      state.starts += 1;
      if (state.starts === completesOn) return 'done';
      await new Promise<void>((resolve) => hung.push(resolve));
      return 'released';
    },
  };
  return { state, processor };
}

async function waitFor<T>(read: () => Promise<T | undefined> | T | undefined, withinMs: number) {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    const v = await read();
    if (v !== undefined) return v;
    await Bun.sleep(25);
  }
  throw new Error(`condition not met within ${withinMs}ms`);
}

async function stalledCheckAt(queue: string): Promise<string | undefined> {
  const { rows } = await pool.query(
    `select value from ${SCHEMA}.meta where queue = $1 and field = 'stalled-check'`,
    [queue]
  );
  return rows[0]?.value;
}

async function resetStalledThrottle(queue: string): Promise<void> {
  await pool.query(`delete from ${SCHEMA}.meta where queue = $1 and field = 'stalled-check'`, [
    queue,
  ]);
}

/** Boot a worker and wait out its own start-up stalled check, so it cannot race ours. */
async function boot(queue: string, processor: unknown): Promise<PgWorker> {
  await resetStalledThrottle(queue);
  const client = new WorkerClient();
  clients.push(client);
  client.configure({ connection: databaseUrl!, queueName: queue, dlqName: `${queue}-dlq` });
  client.register(processor as never);
  const worker = (await client.start()) as unknown as PgWorker;
  worker.on('error', () => undefined);
  await worker.waitUntilReady();
  await waitFor(() => stalledCheckAt(queue), 5_000);
  return worker;
}

function clientOf(worker: PgWorker): WorkerClient {
  const client = clients.find((c) => (c as unknown as { worker: unknown }).worker === worker);
  if (!client) throw new Error('no WorkerClient owns that worker');
  return client;
}

async function closesWithin(close: Promise<void>, ms: number): Promise<void> {
  const outcome = await Promise.race([
    close.then(() => 'closed' as const),
    Bun.sleep(ms).then(() => 'hung' as const),
  ]);
  expect(outcome).toBe('closed');
}

const RESTARTS = {
  /** `WorkerClient.close(true)` on its own. */
  'a force-close': async (worker: PgWorker) => {
    await closesWithin(clientOf(worker).close(true), 5_000);
  },
  /** What `apps/backend/worker` does on SIGTERM: drain, and force-close when the budget runs out. */
  'a drain that times out, then a force-close': async (worker: PgWorker) => {
    const client = clientOf(worker);
    const drain = client.close(false);
    await Bun.sleep(200);
    await closesWithin(client.close(true), 5_000);
    await closesWithin(drain, 1_000);
  },
};

/** A process that dies runs no shutdown at all: the job keeps its lock until it expires. */
async function crash(worker: PgWorker): Promise<void> {
  const client = clientOf(worker);
  await worker.close(true);
  // Only releases the client's own handles; the worker is already closed, so
  // nothing reaches the job.
  await client.close(false);
}

/** Thirty seconds of lock expiry and two stalled intervals, without waiting for them. */
async function skipStallClock(queue: string, dead: PgWorker, next: PgWorker): Promise<void> {
  await pool.query(
    `update ${SCHEMA}.job set locked_until_ms = $3
      where queue = $1 and state = 'active' and lock_token like $2`,
    [queue, `${dead.id}:%`, Date.now() - 1]
  );
  const check = next as unknown as { moveStalledJobsToWait(): Promise<void> };
  await resetStalledThrottle(queue);
  await check.moveStalledJobsToWait();
  await resetStalledThrottle(queue);
  await check.moveStalledJobsToWait();
}

async function jobRow(queue: string, id: string) {
  const { rows } = await pool.query(
    `select state::text as state, stalled_count, attempts_made, failed_reason
       from ${SCHEMA}.job where queue = $1 and id = $2`,
    [queue, id]
  );
  return rows[0] as
    | { state: string; stalled_count: number; attempts_made: number; failed_reason: string | null }
    | undefined;
}

async function settled(queue: string, id: string) {
  return waitFor(async () => {
    const row = await jobRow(queue, id);
    return row && (row.state === 'completed' || row.state === 'failed') ? row : undefined;
  }, 10_000);
}

function uniqueQueue(): string {
  return `sc1146-${crypto.randomUUID().slice(0, 8)}`;
}

describe('a long job across worker restarts (SC-1146)', () => {
  test.each(
    Object.entries(RESTARTS)
  )('three restarts by %s mid-job: the job still completes, and no stall is counted', async (_how, restart) => {
    const name = uniqueQueue();
    const queue = makeQueue(name);
    const { state, processor } = longJob(4);
    const job = await queue.add('long-job', {}, { attempts: 2 });

    let worker = await boot(name, processor);
    for (let n = 1; n <= 3; n++) {
      const outcome = await waitFor(async () => {
        if (state.starts === n) return 'running';
        const row = await jobRow(name, job.id!);
        return row?.state === 'failed' ? row : undefined;
      }, 10_000);
      if (outcome !== 'running') {
        throw new Error(`the job failed before run ${n}: ${JSON.stringify(outcome)}`);
      }
      await restart(worker);
      const next = await boot(name, processor);
      await skipStallClock(name, worker, next);
      worker = next;
    }

    const row = await settled(name, job.id!);
    expect(row.state).toBe('completed');
    expect(state.starts).toBe(4);
    expect(row.stalled_count).toBe(0);
    // The completing run is the only attempt counted; the three interrupted
    // runs spent none.
    expect(row.attempts_made).toBe(1);
  });

  test('a job that crashes the worker every time ends up failed, after exactly two runs', async () => {
    const name = uniqueQueue();
    const queue = makeQueue(name);
    const { state, processor } = longJob(Number.POSITIVE_INFINITY);
    const job = await queue.add('long-job', {}, { attempts: 2 });

    let worker = await boot(name, processor);
    for (let crashes = 1; crashes <= 4; crashes++) {
      const outcome = await waitFor(async () => {
        if (state.starts === crashes) return 'running';
        const row = await jobRow(name, job.id!);
        return row?.state === 'failed' ? 'failed' : undefined;
      }, 10_000);
      if (outcome === 'failed') break;
      await crash(worker);
      const next = await boot(name, processor);
      await skipStallClock(name, worker, next);
      worker = next;
    }

    const row = await settled(name, job.id!);
    expect(row.state).toBe('failed');
    expect(row.failed_reason).toBe('job stalled more than allowable limit');
    // maxStalledCount is 1: the first crash is forgiven, the second is not.
    expect(state.starts).toBe(2);
    expect(row.stalled_count).toBe(2);
  });
});
