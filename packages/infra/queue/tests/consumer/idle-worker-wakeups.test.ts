import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createPostgresBackend, type PostgresQueueBackend, Queue, Worker } from 'bullmq';
import { Pool } from 'pg';
import { runQueueMigrations } from '../../src/migrate';

/**
 * SC-963. An idle BullMQ worker cannot let a scale-to-zero Postgres suspend:
 * it queries every 10s (a hardcoded block cap, used whenever a delayed job
 * exists, and every schedule is one) and every 30s (the stalled check), while
 * Neon needs 300s with no query at all.
 * `patches/bullmq@6.2.0.patch` makes the cap an option, skips the
 * stalled check while an idle worker's LISTEN connection is down, and
 * re-establishes that connection lazily — on the worker's next wake, never on
 * the disconnect, because on Neon the disconnect IS the suspend and an eager
 * reconnect wakes the compute straight back up.
 *
 * These drive the real Postgres backend. Each latency arm is a job that must
 * start within a stated bound; the lost-LISTEN arm also asserts the job DID
 * wait for the timer, which is what shows the notification really was lost
 * rather than the arm passing on a NOTIFY it never exercised.
 */

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must be set — the test preload sets it');

const SCHEMA = 'bullmq';
const pool = new Pool({ connectionString: databaseUrl, max: 1 });

afterAll(async () => {
  await pool.end();
});

type PgWorker = Worker<unknown, unknown, string, PostgresQueueBackend>;
type PgQueue = Queue<unknown, unknown, string, unknown, unknown, string, PostgresQueueBackend>;

function withAppName(url: string, name: string): string {
  const u = new URL(url);
  u.searchParams.set('application_name', name);
  return u.toString();
}

const open: Array<{ close: () => Promise<unknown> }> = [];
const queues: PgQueue[] = [];

function makeQueue(name: string): PgQueue {
  const q = new Queue(
    name,
    {
      connection: {
        connectionString: withAppName(databaseUrl!, `producer-${name}`),
        schema: SCHEMA,
      },
    } as never,
    createPostgresBackend
  ) as unknown as PgQueue;
  queues.push(q);
  return q;
}

function makeWorker(
  name: string,
  opts: Record<string, unknown>
): { worker: PgWorker; started: Map<string, number> } {
  const started = new Map<string, number>();
  const worker = new Worker(
    name,
    async () => undefined,
    {
      connection: { connectionString: withAppName(databaseUrl!, name), schema: SCHEMA },
      concurrency: 1,
      ...opts,
    } as never,
    createPostgresBackend
  ) as unknown as PgWorker;
  worker.on('active', (job) => started.set(job.name, Date.now()));
  worker.on('error', () => undefined);
  open.push(worker);
  return { worker, started };
}

async function waitFor<T>(read: () => T | undefined, withinMs: number): Promise<T> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    const v = read();
    if (v !== undefined) return v;
    await Bun.sleep(25);
  }
  throw new Error(`condition not met within ${withinMs}ms`);
}

function uniqueQueue(): string {
  return `sc963-${crypto.randomUUID().slice(0, 8)}`;
}

beforeAll(async () => {
  await runQueueMigrations(databaseUrl);
});

afterEach(async () => {
  for (const w of open.splice(0)) await w.close();
  for (const q of queues.splice(0)) {
    await q.obliterate({ force: true }).catch(() => undefined);
    await q.close();
  }
});

describe('the maximumBlockTimeout option (SC-963)', () => {
  test('an idle worker blocks for the configured cap, and keeps the stock 10s when none is set', async () => {
    const name = uniqueQueue();
    const farFuture = Date.now() + 3_600_000;
    const configured = makeWorker(name, { autorun: false, maximumBlockTimeout: 900 })
      .worker as unknown as {
      getBlockTimeout(blockUntil: number): number;
    };
    const stock = makeWorker(name, { autorun: false }).worker as unknown as {
      getBlockTimeout(blockUntil: number): number;
    };

    expect(configured.getBlockTimeout(farFuture)).toBe(900);
    expect(stock.getBlockTimeout(farFuture)).toBe(10);
  });
});

describe('an idle worker with a far-future delayed job still starts new work promptly (SC-963)', () => {
  async function idleWorker(opts: Record<string, unknown>) {
    const name = uniqueQueue();
    const queue = makeQueue(name);
    await queue.add('far-future', {}, { delay: 3_600_000 });
    const { worker, started } = makeWorker(name, opts);
    await worker.waitUntilReady();
    await Bun.sleep(500);
    return { name, queue, worker, started };
  }

  // The bounds are loose for a loaded gate; anything under a few seconds
  // already rules out the 900s timer they exist to distinguish from.
  test('an immediate job starts within 3s, off the NOTIFY, not the 900s timer', async () => {
    const { queue, started } = await idleWorker({ maximumBlockTimeout: 900, drainDelay: 900 });
    const addedAt = Date.now();
    await queue.add('immediate', {});
    const startedAt = await waitFor(() => started.get('immediate'), 5_000);
    expect(startedAt - addedAt).toBeLessThan(3_000);
  });

  test('a delayed job added while idle starts when it comes due, not at the 900s timer', async () => {
    const { queue, started } = await idleWorker({ maximumBlockTimeout: 900, drainDelay: 900 });
    const addedAt = Date.now();
    await queue.add('due-soon', {}, { delay: 1_500 });
    const startedAt = await waitFor(() => started.get('due-soon'), 6_000);
    expect(startedAt - addedAt).toBeGreaterThanOrEqual(1_400);
    expect(startedAt - addedAt).toBeLessThan(4_500);
  });

  test('after the LISTEN connection dies, the worker waits for its timer without touching the database, then listens again', async () => {
    const CAP_S = 4;
    const { name, queue, started } = await idleWorker({
      maximumBlockTimeout: CAP_S,
      drainDelay: CAP_S,
      // Short on purpose: an unguarded stalled check would query inside the
      // silent window below and fail it.
      stalledInterval: 1_000,
    });

    // Put the worker into a FRESH wait, so its timer fires CAP_S from here.
    await queue.add('prime', {});
    await waitFor(() => started.get('prime'), 5_000);
    await Bun.sleep(300);

    // What a Neon suspend does to the one connection the worker holds open.
    const killed = await pool.query(
      `select pg_terminate_backend(pid) as ok, pid from pg_stat_activity
       where application_name = $1 and query like '%LISTEN bullmq_jobs;%'`,
      [name]
    );
    expect(killed.rows.length).toBe(1);
    const killedAt = Date.now();

    await Bun.sleep(200);
    const addedAt = Date.now();
    await queue.add('while-suspended', {});

    const startedAt = await waitFor(() => started.get('while-suspended'), (CAP_S + 3) * 1_000);
    // The control: the job WAITED, so the NOTIFY really had nobody to reach.
    expect(startedAt - addedAt).toBeGreaterThan(1_500);
    // The bound: no later than the timer that was already running.
    expect(startedAt - killedAt).toBeLessThan((CAP_S + 2) * 1_000);

    // Lazy: between the kill and the timer the worker issued nothing at all —
    // no reconnect, no stalled check, no probe.
    const silentUntil = startedAt - 250;
    const touched = await pool.query(
      `select count(*)::int as n from pg_stat_activity
       where (application_name = $1 or application_name like $2)
         and query_start > to_timestamp($3) + interval '50 milliseconds'
         and query_start < to_timestamp($4)`,
      [name, `${name}:%`, killedAt / 1000, silentUntil / 1000]
    );
    expect(touched.rows[0]?.n).toBe(0);

    // And it listens again: the next job arrives on a NOTIFY, not a timer.
    await Bun.sleep(500);
    const againAt = Date.now();
    await queue.add('after-reconnect', {});
    const againStartedAt = await waitFor(() => started.get('after-reconnect'), (CAP_S + 3) * 1_000);
    expect(againStartedAt - againAt).toBeLessThan(3_000);
  });
});
