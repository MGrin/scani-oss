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

/**
 * One stalled-job check, as the worker issued it (SC-1403). `suspended` is the
 * state the guard in `stalledChecker` reads: an idle wait with the LISTEN
 * connection gone. A check in that state is exactly what the silent window
 * forbids; a check after the wait ended is the worker being awake.
 */
type StalledCheck = { at: number; waiting: boolean; suspended: boolean };
/**
 * One idle wait, as the worker's own loop saw it (SC-1403). `endedAt` is taken
 * when the backend's wait resolves and before the worker continues, so every
 * query of the wake — the fetch, the reconnect, the re-LISTEN, a stalled tick —
 * is sent after it, on whichever connection.
 */
type IdleWait = { startedAt: number; endedAt?: number };
/**
 * Every time the worker reached for Postgres, by what it called (SC-1403): a
 * pooled query, a pooled checkout, or a LISTEN client asked for while the old
 * one is lost (a reconnect). Recorded in-process at the call, so a query is
 * counted however many more its connection issues afterwards —
 * `pg_stat_activity` keeps only each backend's LAST query, and with BullMQ's
 * guard removed a suspended stalled check was overwritten there by the wake's
 * own queries and read as silence.
 */
type DbTouch = { at: number; via: 'query' | 'connect' | 'reconnect'; text?: string };
type PgConnectionInternals = {
  listenClientLost: boolean;
  getListenClient(): Promise<unknown>;
  pool: {
    query(...args: unknown[]): unknown;
    connect(...args: unknown[]): unknown;
  };
};
type StalledInternals = {
  moveStalledJobsToWait(): Promise<void>;
  waiting: unknown;
  backend: {
    blockingConnectionLost: boolean;
    waitForJob(blockTimeout: number): Promise<unknown>;
    connection: PgConnectionInternals;
  };
};

function makeWorker(
  name: string,
  opts: Record<string, unknown>
): {
  worker: PgWorker;
  started: Map<string, number>;
  stalledChecks: StalledCheck[];
  waits: IdleWait[];
  touches: DbTouch[];
} {
  const started = new Map<string, number>();
  const stalledChecks: StalledCheck[] = [];
  const waits: IdleWait[] = [];
  const touches: DbTouch[] = [];
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
  const internals = worker as unknown as StalledInternals;
  const check = internals.moveStalledJobsToWait.bind(worker);
  internals.moveStalledJobsToWait = () => {
    stalledChecks.push({
      at: Date.now(),
      waiting: Boolean(internals.waiting),
      suspended: Boolean(internals.waiting && internals.backend.blockingConnectionLost),
    });
    return check();
  };
  const backend = internals.backend;
  const wait = backend.waitForJob.bind(backend);
  backend.waitForJob = (blockTimeout) => {
    const record: IdleWait = { startedAt: Date.now() };
    waits.push(record);
    return wait(blockTimeout).then((value) => {
      record.endedAt = Date.now();
      return value;
    });
  };
  const connection = backend.connection;
  const pool = connection.pool;
  const query = pool.query.bind(pool);
  pool.query = (...args) => {
    const [text] = args;
    const sql = typeof text === 'string' ? text : String((text as { text?: unknown })?.text);
    touches.push({ at: Date.now(), via: 'query', text: sql.slice(0, 80) });
    return query(...args);
  };
  const checkout = pool.connect.bind(pool);
  pool.connect = (...args) => {
    touches.push({ at: Date.now(), via: 'connect' });
    return checkout(...args);
  };
  const listenClient = connection.getListenClient.bind(connection);
  connection.getListenClient = () => {
    if (connection.listenClientLost) touches.push({ at: Date.now(), via: 'reconnect' });
    return listenClient();
  };
  open.push(worker);
  return { worker, started, stalledChecks, waits, touches };
}

function touchesBetween(touches: DbTouch[], fromMs: number, toMs: number): DbTouch[] {
  return touches.filter((t) => t.at > fromMs && t.at < toMs);
}

/**
 * Returns once the worker is back in an idle wait after `sinceMs` (SC-1403).
 * The cut must land inside a wait: a worker cut while still awake reconnects
 * at once, which is not the suspended wait these arms are about. A 300ms sleep
 * stood in for this, and at load 50-130 it cut before the wait in 2 of 256 runs.
 */
async function idleAgain(waits: IdleWait[], sinceMs: number): Promise<void> {
  await waitFor(
    () => (waits.some((w) => w.startedAt >= sinceMs && w.endedAt === undefined) ? true : undefined),
    5_000
  );
}

/** The idle wait that was in flight when the listener was cut. */
function waitSpanning(waits: IdleWait[], at: number): IdleWait {
  const found = waits.find(
    (w) => w.startedAt <= at && (w.endedAt === undefined || w.endedAt >= at)
  );
  if (!found) throw new Error(`no idle wait was in flight at ${at}`);
  return found;
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
    const { worker, started, stalledChecks, waits, touches } = makeWorker(name, opts);
    await worker.waitUntilReady();
    await Bun.sleep(500);
    return { name, queue, worker, started, stalledChecks, waits, touches };
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
    const { name, queue, started, stalledChecks, waits, touches } = await idleWorker({
      maximumBlockTimeout: CAP_S,
      drainDelay: CAP_S,
      // Short on purpose: an unguarded stalled check would query inside the
      // silent window below and fail it.
      stalledInterval: 1_000,
    });

    // Put the worker into a FRESH wait, so its timer fires CAP_S from here.
    await queue.add('prime', {});
    const primedAt = await waitFor(() => started.get('prime'), 5_000);
    await idleAgain(waits, primedAt);

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

    // The guard held: no stalled check ran while the wait was suspended.
    const afterCut = stalledChecks.filter((c) => c.at >= killedAt);
    expect(afterCut.filter((c) => c.suspended)).toEqual([]);

    // It waited for its TIMER: the wait in flight at the cut ran its full cap.
    // A lower bound, so load can only make it longer. Without it, a worker that
    // ended its wait at the cut and reconnected at once would pass the count
    // below with an empty window.
    const suspendedWait = waitSpanning(waits, killedAt);
    const wokeAt = suspendedWait.endedAt ?? Number.NaN;
    expect(wokeAt - suspendedWait.startedAt).toBeGreaterThanOrEqual(CAP_S * 1_000 - 50);
    expect(wokeAt).toBeLessThanOrEqual(silentUntil);

    // Lazy: until its wait ended, it issued nothing at all — no reconnect, no
    // stalled check, no probe. The window closes when the worker's own wait
    // resolves (SC-1403), recorded in-process before it continues. It used to
    // close at the re-LISTEN, and that was one EVENT too late: after the timer
    // the loop fetches (`moveToActive`) and a 1s stalled tick may run, on other
    // connections, before the reconnect's LISTEN. Under CI contention one of
    // them reached Postgres first and read as "touched the database while
    // waiting" (main #759, #853). Everything after `wokeAt` is the wake.
    // Counted twice: in-process, which sees every call; and by Postgres, which
    // also sees a connection this worker opened some other way.
    expect(touchesBetween(touches, killedAt, wokeAt)).toEqual([]);
    expect(await queriesBetween(name, killedAt, wokeAt)).toBe(0);

    // And it listens again, so the next job's NOTIFY has somebody to reach.
    // Counted at the enqueue like the lost-LISTEN arms (SC-1220), not timed: a
    // 3s bound on the pickup told NOTIFY from the 4s timer only on a quiet box,
    // and at load ~100 it read 4.3s in the fixed and the unfixed copy alike
    // (SC-1403). The `toBe(0)` after the cut is this probe's control.
    expect(await listeners(name)).toBe(1);
    await queue.add('after-reconnect', {});
    await waitFor(() => started.get('after-reconnect'), (CAP_S + 3) * 1_000);
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
    const { name, queue, started, waits } = await idleWorker({
      maximumBlockTimeout: CAP_S,
      drainDelay: CAP_S,
      stalledInterval: 1_000,
    });
    await queue.add('prime', {});
    const primedAt = await waitFor(() => started.get('prime'), 5_000);
    await idleAgain(waits, primedAt);

    const killedAt = await cutListener(name);
    await queue.add('while-suspended', {});

    // A genuine query from a connection Postgres attributes to this worker,
    // 200ms into the window rather than at its edge.
    await Bun.sleep(200);
    const impostor = new Pool({ connectionString: withAppName(databaseUrl!, name), max: 1 });
    try {
      await impostor.query('select 1');
      await reListenedAt(name, (CAP_S + 4) * 1_000);
      const wokeAt = waitSpanning(waits, killedAt).endedAt ?? Number.NaN;
      expect(await queriesBetween(name, killedAt, wokeAt)).toBeGreaterThanOrEqual(1);
    } finally {
      await impostor.end();
    }
  });

  /**
   * CONTROL for "it waited for its timer" (SC-1403). The silent window now ends
   * when the worker's wait resolves, so a worker that ended its wait at the cut
   * and reconnected straight away would leave an empty window and pass the
   * count. The arm above refuses that with a lower bound on the wait; this ends
   * the wait at the cut, as such a worker would, and shows the bound fails.
   */
  test('CONTROL: a wait ended at the cut reads as shorter than its timer', async () => {
    const CAP_S = 4;
    const { name, queue, worker, started, waits } = await idleWorker({
      maximumBlockTimeout: CAP_S,
      drainDelay: CAP_S,
      stalledInterval: 1_000,
    });
    await queue.add('prime', {});
    const primedAt = await waitFor(() => started.get('prime'), 5_000);
    await idleAgain(waits, primedAt);

    const killedAt = await cutListener(name);
    interruptIdleWait(worker);
    const cut = waitSpanning(waits, killedAt);
    const endedAt = await waitFor(() => cut.endedAt, 2_000);
    expect(endedAt - cut.startedAt).toBeLessThan(CAP_S * 1_000 - 50);
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
