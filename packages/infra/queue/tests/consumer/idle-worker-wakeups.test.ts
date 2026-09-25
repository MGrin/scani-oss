import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createPostgresBackend, type PostgresQueueBackend, Queue, Worker } from 'bullmq';
import { Pool } from 'pg';
import { runQueueMigrations } from '../../src/migrate';
import { interruptIdleWait, serveWorkerWake, WorkerWakeClient } from '../../src/wake/worker-wake';

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
 * start within a stated bound; the lost-LISTEN arms also count the worker's
 * listeners at the enqueue, which is what shows the notification really was
 * lost rather than the arm passing on a NOTIFY it never exercised.
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

const LISTENERS = `from pg_stat_activity
  where application_name = $1 and query like '%LISTEN bullmq_jobs;%'`;

async function listeners(name: string): Promise<number> {
  const r = await pool.query(`select count(*)::int as n ${LISTENERS}`, [name]);
  return r.rows[0]?.n ?? -1;
}

/**
 * When the worker's LISTEN came back, as Postgres timed it (SC-1225).
 *
 * The re-LISTEN is the first thing the worker does when its idle wait ends —
 * measured 2026-09-17 on this fixture, the wake is three queries 1ms apart and
 * `Subscribe to the shared job-notification channel` is the first of them, 17ms
 * before the job starts. That makes it the EVENT that ends the silent window,
 * where `startedAt - 250ms` was a guess about how long a wake takes.
 *
 * Postgres's own `query_start` is returned rather than the polling instant: the
 * other two queries of the wake burst land 1-2ms after the LISTEN and would sit
 * INSIDE a window bounded by when this function happened to look.
 */
async function reListenedAt(name: string, withinMs: number): Promise<number> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    const r = await pool.query(
      `select extract(epoch from query_start) * 1000 as at ${LISTENERS} order by query_start limit 1`,
      [name]
    );
    const at = r.rows[0]?.at;
    if (at !== undefined) return Number(at);
    await Bun.sleep(25);
  }
  throw new Error(`${name} did not LISTEN again within ${withinMs}ms`);
}

/**
 * How many queries the worker's own connections issued in a window, by
 * Postgres's clock.
 *
 * `pg_stat_activity` keeps only the LAST query per backend, so this counts
 * backends whose most recent query landed in the window rather than every query
 * — enough for "did it touch the database at all", which is the claim, and the
 * control below is what shows it can still come back non-zero.
 *
 * WHAT IT CANNOT SEE, measured while building that control: a query from a
 * connection that has since CLOSED. The backend is gone from the view, so the
 * query is invisible however recent it was — a falsifier that opened a
 * connection, queried and closed it read zero and looked like a working check
 * reporting silence. The worker holds its connections open across the whole
 * window, which is why this is sound for the subject and not in general; the
 * control keeps its connection open for exactly that reason.
 */
async function queriesBetween(name: string, fromMs: number, toMs: number): Promise<number> {
  const r = await pool.query(
    `select count(*)::int as n from pg_stat_activity
      where (application_name = $1 or application_name like $2)
        and query_start > to_timestamp($3) + interval '50 milliseconds'
        and query_start < to_timestamp($4)`,
    [name, `${name}:%`, fromMs / 1000, toMs / 1000]
  );
  return r.rows[0]?.n ?? -1;
}

/**
 * What a Neon suspend does to the one connection the worker holds open. Returns
 * once a reading shows NO listener, and the time of the cut that got there.
 *
 * Counted, not slept (SC-1220). These arms need the NOTIFY for the next job to
 * reach nobody, and they used to show it by the job starting LATE — a lower
 * bound, which load breaks from the other side: a slow setup lets the worker's
 * timer come due before the enqueue, and a loaded CI run read 603ms against
 * `> 3500`. A listener count of zero at the enqueue is the fact itself. A timer
 * that fires mid-cut listens again, so this cuts again rather than trusting one.
 */
async function cutListener(name: string): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const killed = await pool.query(`select pg_terminate_backend(pid) ${LISTENERS}`, [name]);
    // After the terminate returns, as before: until then the listener is alive
    // and the worker may still query, which the silent window must not count.
    const cutAt = Date.now();
    // The control: a query matching nothing would make every zero below vacuous.
    if (attempt === 0) expect(killed.rows.length).toBe(1);
    for (let poll = 0; poll < 40; poll++) {
      if ((await listeners(name)) === 0) return cutAt;
      await Bun.sleep(25);
    }
  }
  throw new Error(`the LISTEN connection of ${name} would not stay cut`);
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
  // already rules out the 900s timer they exist to distinguish from. Every
  // UPPER bound on elapsed time in this file is tagged `// [wall-clock]`, so
  // the deploy preflight reads its failure as the box rather than a
  // regression (SC-1149). The delayed job's lower bound is not: its clock is the
  // job's own delay, which no setup can spend. A bound measured from the
  // ENQUEUE against a timer armed during the setup was, and a slow setup made
  // that job start sooner (SC-1220) — those arms count listeners instead.
  test('an immediate job starts within 3s, off the NOTIFY, not the 900s timer', async () => {
    const { queue, started } = await idleWorker({ maximumBlockTimeout: 900, drainDelay: 900 });
    const addedAt = Date.now();
    await queue.add('immediate', {});
    const startedAt = await waitFor(() => started.get('immediate'), 5_000);
    expect(startedAt - addedAt).toBeLessThan(3_000); // [wall-clock]
  });

  test('a delayed job added while idle starts when it comes due, not at the 900s timer', async () => {
    const { queue, started } = await idleWorker({ maximumBlockTimeout: 900, drainDelay: 900 });
    const addedAt = Date.now();
    await queue.add('due-soon', {}, { delay: 1_500 });
    const startedAt = await waitFor(() => started.get('due-soon'), 6_000);
    expect(startedAt - addedAt).toBeGreaterThanOrEqual(1_400);
    expect(startedAt - addedAt).toBeLessThan(4_500); // [wall-clock]
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

    const killedAt = await cutListener(name);
    // The control: the NOTIFY for this job really had nobody to reach.
    expect(await listeners(name)).toBe(0);
    await queue.add('while-suspended', {});

    // The window closes at the re-LISTEN, which is an EVENT in the worker's own
    // wake (SC-1225). It used to close at `startedAt - 250`, and that 250ms was
    // a guess about how long a wake takes: the wake is a burst of three queries
    // ending with the job starting, so on a loaded box the whole burst lands
    // INSIDE the "silent" window and the count reads 3. Nightly #3 read exactly
    // that — those three queries, not a violation — and a red main Verifier
    // stops the deploy. Bounded by the event, load cannot move it.
    const silentUntil = await reListenedAt(name, (CAP_S + 4) * 1_000);
    const startedAt = await waitFor(() => started.get('while-suspended'), (CAP_S + 3) * 1_000);
    // The bound: no later than the timer that was already running.
    expect(startedAt - killedAt).toBeLessThan((CAP_S + 2) * 1_000); // [wall-clock]

    // Lazy: between the kill and that re-LISTEN the worker issued nothing at
    // all — no reconnect, no stalled check, no probe.
    expect(await queriesBetween(name, killedAt, silentUntil)).toBe(0);

    // And it listens again: the next job arrives on a NOTIFY, not a timer.
    await Bun.sleep(500);
    const againAt = Date.now();
    await queue.add('after-reconnect', {});
    const againStartedAt = await waitFor(() => started.get('after-reconnect'), (CAP_S + 3) * 1_000);
    expect(againStartedAt - againAt).toBeLessThan(3_000); // [wall-clock]
  });

  /**
   * CONTROL for the silent window (SC-1225). The arm above asserts the worker
   * touched nothing between the cut and its re-LISTEN; this asserts the same
   * window can come back non-zero, by issuing one query inside it on a
   * connection carrying the worker's own `application_name`.
   *
   * It is what separates "the worker was quiet" from "the count cannot see a
   * query" — which is the failure the window's old wall-clock bound had in the
   * opposite direction, and a count that can only read zero would be worse than
   * the guess it replaced.
   */
  test('CONTROL: a query inside the silent window is counted', async () => {
    const CAP_S = 4;
    const { name, queue, started } = await idleWorker({
      maximumBlockTimeout: CAP_S,
      drainDelay: CAP_S,
      stalledInterval: 1_000,
    });
    await queue.add('prime', {});
    await waitFor(() => started.get('prime'), 5_000);
    await Bun.sleep(300);

    const killedAt = await cutListener(name);
    await queue.add('while-suspended', {});

    // A genuine query from a connection Postgres attributes to this worker,
    // 200ms into the window rather than at its edge.
    await Bun.sleep(200);
    const impostor = new Pool({ connectionString: withAppName(databaseUrl!, name), max: 1 });
    try {
      await impostor.query('select 1');
      const silentUntil = await reListenedAt(name, (CAP_S + 4) * 1_000);
      expect(await queriesBetween(name, killedAt, silentUntil)).toBeGreaterThanOrEqual(1);
    } finally {
      await impostor.end();
    }
  });
});

/**
 * SC-1144. The price of the arm above is a job enqueued while the compute is
 * suspended waiting for the worker's timer — up to 600s in production. The api
 * now pings the worker after a user enqueues, and the ping interrupts that
 * wait. All three arms share one fixture and differ only in the ping, so the
 * control is the same fixture with the wake disabled.
 *
 * NO TIMER RUNS INSIDE THESE ARMS (SC-1242). With a 6s cap, the worker's own
 * timer re-LISTENed before the post-add read on a loaded gate (1 of 13080), so
 * a correct run read 1 where 0 was asserted. The cap is 900s here, so only the
 * wake or the test can end the idle wait. The two arms whose subject is the
 * timer end it with `interruptIdleWait`, which is exactly what the timer does,
 * after showing the job did not start on its own. That the real timer ends the
 * wait and re-LISTENs is the silent-window arm's subject above.
 */
describe('a job enqueued while the LISTEN connection is down (SC-1144)', () => {
  const CAP_S = 900;
  // The wake arm's bound. The timer arms hold this long first, so "it would
  // have started anyway" is ruled out over the same interval the wake beats.
  const WAKE_BOUND_MS = 2_500;
  const SECRET = 'test_wake_secret_at_least_32_characters_long';

  async function suspendedWorker() {
    const name = uniqueQueue();
    const queue = makeQueue(name);
    await queue.add('far-future', {}, { delay: 3_600_000 });
    const { worker, started } = makeWorker(name, {
      maximumBlockTimeout: CAP_S,
      drainDelay: CAP_S,
      stalledInterval: 1_000,
    });
    await worker.waitUntilReady();
    await Bun.sleep(500);
    await queue.add('prime', {});
    await waitFor(() => started.get('prime'), 5_000);
    await Bun.sleep(300);

    const wakes = { n: 0 };
    const server = serveWorkerWake({
      port: 0,
      hostname: '127.0.0.1',
      secret: SECRET,
      onWake: () => {
        wakes.n += 1;
        interruptIdleWait(worker);
      },
      version: {},
    });
    open.push({ close: async () => server.stop() });

    // Last, so nothing slow stands between the cut and the enqueue.
    await cutListener(name);
    const listenersAtEnqueue = await listeners(name);
    return {
      name,
      queue,
      started,
      wakes,
      worker,
      listenersAtEnqueue,
      url: `http://127.0.0.1:${server.port}`,
    };
  }

  /**
   * Enqueue, then read the listener count AGAIN (SC-1225).
   *
   * The zero read in the fixture above is taken BEFORE the add, and the Judge's
   * review of SC-1220 (bus #9421/#9422) found what that leaves open: if the
   * worker re-LISTENs in the gap, the NOTIFY for this job reaches a live
   * connection, the job arrives on the listener rather than the timer, and
   * every arm below still passes — vacuously, having exercised the path it
   * exists to rule out.
   *
   * Reading after the add is what closes it: the job's own NOTIFY had nobody to
   * reach only if nobody was listening AT that moment.
   */
  async function addWithNobodyListening(
    queue: PgQueue,
    name: string,
    job: string
  ): Promise<number> {
    const addedAt = Date.now();
    await queue.add(job, {});
    expect(await listeners(name)).toBe(0);
    return addedAt;
  }

  function wakeClient(url: string | undefined, secret: string) {
    const c = new WorkerWakeClient();
    c.configure({ url, secret });
    return c;
  }

  test('with the wake, it starts in seconds, and the worker listens again', async () => {
    const { name, queue, started, wakes, listenersAtEnqueue, url } = await suspendedWorker();
    expect(listenersAtEnqueue).toBe(0);
    const addedAt = await addWithNobodyListening(queue, name, 'while-suspended');
    expect(await wakeClient(url, SECRET).ping()).toBe('woken');
    expect(wakes.n).toBe(1);
    const startedAt = await waitFor(() => started.get('while-suspended'), 5_000);
    expect(startedAt - addedAt).toBeLessThan(WAKE_BOUND_MS); // [wall-clock]

    await Bun.sleep(500);
    const againAt = Date.now();
    await queue.add('after-wake', {});
    const againStartedAt = await waitFor(() => started.get('after-wake'), 5_000);
    expect(againStartedAt - againAt).toBeLessThan(WAKE_BOUND_MS); // [wall-clock]
  });

  /**
   * Nothing but the end of the idle wait can start the job: no listener, no
   * wake, and a 900s timer. Hold for the wake arm's bound, then end the wait as
   * the timer would. A lower bound on a start that nothing can cause, so load
   * only lengthens the hold, never shortens it.
   */
  async function startsOnlyWhenTheWaitEnds(
    worker: PgWorker,
    started: Map<string, number>,
    job: string
  ): Promise<void> {
    await Bun.sleep(WAKE_BOUND_MS);
    expect(started.get(job)).toBeUndefined();
    const endedAt = Date.now();
    interruptIdleWait(worker);
    const startedAt = await waitFor(() => started.get(job), 5_000);
    expect(startedAt - endedAt).toBeLessThan(WAKE_BOUND_MS); // [wall-clock]
  }

  // The control. Without it the arm above could pass on a NOTIFY that still
  // reached a live connection, and would say nothing about the wake.
  //
  // It used to show the wait as `> 3500ms` after the enqueue. It now shows the
  // two facts that leave the timer as the only way in: nobody was listening
  // when the job was enqueued, and nothing woke the worker (SC-1220).
  test('CONTROL: with the wake disabled, it waits for the timer', async () => {
    const { name, queue, started, wakes, worker, listenersAtEnqueue } = await suspendedWorker();
    expect(listenersAtEnqueue).toBe(0);
    await addWithNobodyListening(queue, name, 'while-suspended');
    expect(await wakeClient(undefined, SECRET).ping()).toBe('unconfigured');
    await startsOnlyWhenTheWaitEnds(worker, started, 'while-suspended');
    expect(wakes.n).toBe(0);
  });

  test('a failed wake costs nothing: the job still starts when the timer ends the wait', async () => {
    const { name, queue, started, wakes, worker, listenersAtEnqueue, url } =
      await suspendedWorker();
    expect(listenersAtEnqueue).toBe(0);
    await addWithNobodyListening(queue, name, 'while-suspended');
    expect(await wakeClient(url, 'another_secret_of_at_least_32_characters').ping()).toBe('failed');
    await startsOnlyWhenTheWaitEnds(worker, started, 'while-suspended');
    expect(wakes.n).toBe(0);
  });

  /**
   * CONTROL for the post-add read (SC-1225). The three arms above assert that
   * nobody was listening at the moment their job was enqueued; this asserts the
   * same read can come back ONE, on a worker deliberately made to listen again
   * before the add.
   *
   * Without it, `expect(await listeners(name)).toBe(0)` could be passing because
   * the query matches nothing at all — the same vacuity it was added to close,
   * one level down. `interruptIdleWait` is the production wake path, so the
   * re-LISTEN here is the worker's own, not a fixture's imitation of one.
   */
  test('CONTROL: the post-add read sees a listener when the worker has re-LISTENed', async () => {
    const { name, queue, worker } = await suspendedWorker();
    expect(await listeners(name)).toBe(0);

    interruptIdleWait(worker);
    await reListenedAt(name, 5_000);

    await queue.add('while-listening', {});
    expect(await listeners(name)).toBe(1);
  });
});
