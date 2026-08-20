/**
 * SC-327. The detector is worth less than the proof that it fires, so these
 * tests drive the REAL reachability observer with the real error shape ioredis
 * produces during the outage (`getaddrinfo ENOTFOUND scani-worker.internal`,
 * once every ~2s, forever) and assert on the alert.
 *
 * Two of them matter more than the rest:
 *
 *  - `fires` — a strand nobody repairs produces exactly one alert, carrying
 *    the name-resolution flag that tells a human the machine must be replaced.
 *  - `stays quiet across a deploy-shaped strand` — the same error stream, cut
 *    short by the `ready` that SC-321's recycle produces, must produce none.
 *    An alert that cannot tell those apart gets muted within a week.
 */
import { describe, expect, test } from 'bun:test';
import { observeRedisReachability } from '../src/redis-reachability';
import {
  REDIS_STRAND_GRACE_MS,
  type StrandReport,
  startRedisStrandWatchdog,
  strandedRedisError,
} from '../src/redis-strand-watchdog';

/** The error ioredis emits on every retry against an unresolvable 6PN name. */
function enotfound(): Error {
  const err = new Error('getaddrinfo ENOTFOUND scani-worker.internal');
  (err as Error & { code: string }).code = 'ENOTFOUND';
  return err;
}

function econnrefused(): Error {
  const err = new Error('connect ECONNREFUSED');
  (err as Error & { code: string }).code = 'ECONNREFUSED';
  return err;
}

/**
 * Stands in for the ioredis client: the two events the observer listens to,
 * plus a `ping` whose behaviour the test controls.
 *
 * The stranded ping does not reject — it never settles. That is the real
 * behaviour (SC-294): ioredis queues a command issued while the connection is
 * down and resolves it when the connection returns, which for an unresolvable
 * host is never. If this faked a rejection the test would pass against a
 * watchdog that hangs forever in production.
 */
function fakeRedis(pingBehaviour: 'hangs' | 'pongs') {
  const listeners: { error: Array<(e: unknown) => void>; ready: Array<() => void> } = {
    error: [],
    ready: [],
  };
  return {
    on(event: 'error' | 'ready', listener: never) {
      if (event === 'error') listeners.error.push(listener);
      else listeners.ready.push(listener);
      return this;
    },
    ping(): Promise<string> {
      if (pingBehaviour === 'pongs') return Promise.resolve('PONG');
      return new Promise<string>(() => undefined);
    },
    emitError(err: unknown) {
      for (const l of listeners.error) l(err);
    },
    emitReady() {
      for (const l of listeners.ready) l();
    },
  };
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** No-op timers: every test drives `check()` itself, on a clock it controls. */
const noTimers = {
  setIntervalFn: () => ({ unref: () => undefined }),
};

function harness(pingBehaviour: 'hangs' | 'pongs', graceMs = REDIS_STRAND_GRACE_MS) {
  const client = fakeRedis(pingBehaviour);
  const reachability = observeRedisReachability(client, silentLogger, 'redis');
  const alerts: StrandReport[] = [];
  // Anchored to real time, not to a fixed date: `observeRedisReachability`
  // stamps the start of an outage with `new Date()` inside its own `error`
  // handler, so a fake clock in the past would make every strand read as
  // zero-length and the tests would pass against a watchdog that never fires.
  let clock = new Date();
  const watchdog = startRedisStrandWatchdog({
    reachability,
    redis: client,
    onStranded: (report) => alerts.push(report),
    graceMs,
    // Small enough that a hung ping resolves the test in milliseconds while
    // still exercising the real `pingWithin` timer.
    pingTimeoutMs: 5,
    now: () => clock,
    ...noTimers,
  });
  return {
    client,
    alerts,
    watchdog,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
    /** One ioredis retry cycle: an error every 2s for `ms`. */
    async strandFor(ms: number) {
      for (let elapsed = 0; elapsed < ms; elapsed += 2_000) {
        client.emitError(enotfound());
        this.advance(2_000);
      }
      await watchdog.check();
    },
  };
}

describe('redis strand watchdog', () => {
  test('fires once, with the name-resolution flag, when nobody repairs the strand', async () => {
    const h = harness('hangs');

    await h.strandFor(REDIS_STRAND_GRACE_MS + 60_000);

    expect(h.alerts.length).toBe(1);
    const [alert] = h.alerts;
    expect(alert?.nameResolutionFailure).toBe(true);
    expect(alert?.unreachableForMs).toBeGreaterThanOrEqual(REDIS_STRAND_GRACE_MS);
    expect(alert?.lastError).toContain('ENOTFOUND');
    // The PING is what makes this a report of the thing rather than of a
    // proxy for it: it was actually attempted, and it actually did not answer.
    expect(alert?.pingError).toContain('timed out');
    expect(alert?.repeat).toBe(0);

    const err = strandedRedisError(alert as StrandReport);
    expect(err.name).toBe('RedisStrandedError');
    expect(err.message).toContain('will not self-heal');
    expect(err.message).toContain('recycle-redis-consumers.sh');
  });

  test('stays quiet across a deploy-shaped strand', async () => {
    const h = harness('hangs');

    // A worker deploy: consumers strand while the machine is replaced, then
    // SC-321's recycle restarts them and ioredis reconnects. Two minutes is
    // longer than the observed recycle and far short of the grace.
    await h.strandFor(2 * 60_000);
    expect(h.alerts.length).toBe(0);

    h.client.emitReady();
    await h.watchdog.check();
    expect(h.alerts.length).toBe(0);

    // And the clock does not carry over: time spent healthy after a deploy
    // must not accumulate toward the next strand's grace.
    h.advance(REDIS_STRAND_GRACE_MS * 2);
    await h.watchdog.check();
    expect(h.alerts.length).toBe(0);
  });

  test('the deploy-shaped strand is quiet because of the grace, not by accident', async () => {
    // Guards the test above from passing vacuously. The same two minutes of
    // the same errors, with the grace removed, must alert — otherwise "no
    // alert during a deploy" would also be satisfied by a watchdog wired to
    // nothing, which is the state this ticket started in.
    const h = harness('hangs', 0);

    await h.strandFor(2 * 60_000);

    expect(h.alerts.length).toBe(1);
  });

  test('re-arms, so a second strand later in the same process still alerts', async () => {
    const h = harness('hangs');

    await h.strandFor(REDIS_STRAND_GRACE_MS + 60_000);
    expect(h.alerts.length).toBe(1);

    h.client.emitReady();
    await h.watchdog.check();

    await h.strandFor(REDIS_STRAND_GRACE_MS + 60_000);
    expect(h.alerts.length).toBe(2);
    // The counter is per-outage, not per-process: a fresh strand is a fresh
    // first alert, not a repeat of the old one.
    expect(h.alerts[1]?.repeat).toBe(0);
  });

  test('does not alert on a latched tracker whose Redis answers', async () => {
    // ioredis emits `error` for conditions that do not close the socket, and
    // those are never followed by a `ready` — so the tracker can sit
    // "unreachable" against a healthy Redis indefinitely. `/health/deep`
    // refuses to trust the tracker alone for this reason; so does this.
    const h = harness('pongs');

    await h.strandFor(REDIS_STRAND_GRACE_MS * 3);

    expect(h.alerts.length).toBe(0);
  });

  test('repeats on a long outage, but at the repeat cadence not the tick rate', async () => {
    const h = harness('hangs');

    await h.strandFor(REDIS_STRAND_GRACE_MS + 60_000);
    expect(h.alerts.length).toBe(1);

    // Five more minutes of ticking — inside the 15-minute repeat window.
    for (let i = 0; i < 10; i += 1) {
      h.advance(30_000);
      await h.watchdog.check();
    }
    expect(h.alerts.length).toBe(1);

    h.advance(11 * 60_000);
    await h.watchdog.check();
    expect(h.alerts.length).toBe(2);
    expect(h.alerts[1]?.repeat).toBe(1);
  });

  test('distinguishes a refused connection from an unresolvable name', async () => {
    const h = harness('hangs');

    for (let elapsed = 0; elapsed < REDIS_STRAND_GRACE_MS + 60_000; elapsed += 2_000) {
      h.client.emitError(econnrefused());
      h.advance(2_000);
    }
    await h.watchdog.check();

    expect(h.alerts.length).toBe(1);
    // Redis is down or restarting rather than the resolver being broken —
    // still worth alerting on after ten minutes, but it is a different repair.
    expect(h.alerts[0]?.nameResolutionFailure).toBe(false);
    expect(strandedRedisError(h.alerts[0] as StrandReport).message).toContain('connection refused');
  });

  test('carries the remedy of the process that raised it', async () => {
    // The worker IS the machine Redis lives in, so the consumer-recycle
    // default is the wrong instruction there. A page that names a command
    // which repairs nothing is worse than one that names none.
    const client = fakeRedis('hangs');
    const reachability = observeRedisReachability(client, silentLogger, 'redis');
    const alerts: StrandReport[] = [];
    let clock = new Date();
    const watchdog = startRedisStrandWatchdog({
      reachability,
      redis: client,
      onStranded: (report) => alerts.push(report),
      remedy: 'fly machine restart -a scani-worker',
      pingTimeoutMs: 5,
      now: () => clock,
      ...noTimers,
    });

    client.emitError(enotfound());
    clock = new Date(clock.getTime() + REDIS_STRAND_GRACE_MS + 1_000);
    await watchdog.check();

    expect(strandedRedisError(alerts[0] as StrandReport).message).toContain(
      'fly machine restart -a scani-worker'
    );
    expect(strandedRedisError(alerts[0] as StrandReport).message).not.toContain(
      'recycle-redis-consumers'
    );
  });

  test('a strand shorter than the grace never alerts, however many errors it produces', async () => {
    const h = harness('hangs');

    await h.strandFor(REDIS_STRAND_GRACE_MS - 60_000);

    expect(h.alerts.length).toBe(0);
  });
});
