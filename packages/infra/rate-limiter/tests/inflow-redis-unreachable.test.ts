import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import type { Redis } from 'ioredis';
import { RedisInflowRateLimiter } from '../src/index';

/**
 * A limiter whose Redis is unreachable must not hold the request (SC-225).
 *
 * **The production failure this pins.** `api.scani.xyz` was down 14 minutes on
 * 2026-08-15 and the cause was not the route that failed — it was the
 * middleware in front of it. `/health` is a static handler that touches
 * nothing, but every request passes `globalLimiter.tryConsume` first, and that
 * awaits `INCRBY` on the api's shared ioredis connection. That connection is
 * built with `maxRetriesPerRequest: null`, and in ioredis 5.10.1 that is not a
 * number, so `event_handler.js`'s flush branch never runs and a queued command
 * is never rejected. Measured against a real client pointed at a dead port:
 *
 *     maxRetriesPerRequest: null  ->  STILL PENDING after 4000ms
 *     maxRetriesPerRequest: 1     ->  REJECTED MaxRetriesPerRequestError
 *     enableOfflineQueue: false   ->  REJECTED Stream isn't writeable
 *
 * So Fly's check on `/health` did not get a 503. It got nothing at all, timed
 * out, marked both machines critical, and pulled the app out of the load
 * balancer — for a dependency the probe never touches.
 *
 * The stub below is that exact shape: a command that never settles. It is a
 * faithful model of the failing dependency rather than a mock of the fix, and
 * against the old implementation both tests here hang until bun's timeout
 * kills them.
 *
 * **What this does NOT reproduce**: the DNS change itself. The trigger in
 * production was `scani-worker.internal` going unresolvable while the machine
 * Redis lives in was replaced. ioredis handles that part correctly — it passes
 * the raw hostname to `net.createConnection` on every attempt and re-resolves
 * each time (12 `getaddrinfo ENOTFOUND` events in 1200ms at a 100ms retry), so
 * there is no cached answer to invalidate and nothing to fix there. The defect
 * is entirely in how long a caller is willing to wait, and that is what these
 * tests hold.
 */

/** A Redis whose commands never settle — a client with a full offline queue
 *  and no maximum retry count, which is what the api runs. */
function unreachableRedis(): Redis {
  const never = () => new Promise<never>(() => {});
  return { incrby: never, expire: never } as unknown as Redis;
}

/** A Redis that rejects rather than hangs — the same outage seen through a
 *  connection that does bound its retries. */
function rejectingRedis(): Redis {
  const boom = () => Promise.reject(new Error('getaddrinfo ENOTFOUND'));
  return { incrby: boom, expire: boom } as unknown as Redis;
}

/**
 * The clock is pinned because the limiter buckets by a FIXED wall-clock
 * window, not a rolling one (`inflow-rate-limiter.ts:86`):
 *
 *     const windowStart = Math.floor(nowSec / this.windowSec) * this.windowSec;
 *
 * Every call against `unreachableRedis()` waits out the full `timeoutMs`
 * before falling back, so the multi-call tests below sit tens of milliseconds
 * apart in real time. If two of them straddle a minute boundary they land in
 * DIFFERENT buckets and both admit under `max: 1` — the fixture asserting
 * something a fixed-window algorithm never promised.
 *
 * That is not hypothetical: it failed exactly once during an unrelated gate
 * run on 2026-08-15, `Expected: false, Received: true` at roughly one run in
 * 3000 (SC-256). A gate that fails that rarely is worse than one that fails
 * often, because it teaches everyone to re-run rather than to read.
 *
 * `setSystemTime` freezes `Date.now()` while leaving timers on the real clock
 * — verified — so the bucket is deterministic AND the 20ms timeout still
 * fires. A bigger `windowMs` would only have made the straddle rarer, which
 * is the wrong kind of fix for a race that already hides at 1-in-3000.
 *
 * The limiter is not at fault and is unchanged. Pinning a clock the code
 * reads directly is the test's job.
 */
const MID_WINDOW = new Date('2026-08-15T12:00:30.000Z');

beforeEach(() => setSystemTime(MID_WINDOW));
afterEach(() => setSystemTime());

function req(ip = '1.1.1.1'): Request {
  return new Request('http://test/', { headers: { 'cf-connecting-ip': ip } });
}

function limiter(redis: Redis, max = 3) {
  return new RedisInflowRateLimiter(redis, {
    windowMs: 60_000,
    max,
    namespace: 'rl:test',
    // Well under any request budget; production Redis over 6PN answers in ~1ms,
    // so this is ~50x headroom before the fallback engages.
    timeoutMs: 20,
  });
}

describe('a Redis that never answers', () => {
  test('the limiter settles anyway, and admits', async () => {
    const started = performance.now();
    const result = await limiter(unreachableRedis()).tryConsume(req());
    const elapsed = performance.now() - started;

    expect(result.ok).toBe(true);
    // The old implementation returns here never. Any finite number passes the
    // property; the bound is asserted so a future regression to an unbounded
    // await fails loudly rather than slowly.
    expect(elapsed).toBeLessThan(1_000);
  });

  test('it degrades to in-process counting rather than to no limit at all', async () => {
    // Fail-OPEN would hand an attacker an unlimited budget the moment Redis
    // blinks. The package already ships an in-memory counter, so the honest
    // degraded state is per-instance limiting — worst case N x the global
    // limit across N machines, which is two here.
    const l = limiter(unreachableRedis(), 2);
    expect((await l.tryConsume(req('9.9.9.9'))).ok).toBe(true);
    expect((await l.tryConsume(req('9.9.9.9'))).ok).toBe(true);

    const third = await l.tryConsume(req('9.9.9.9'));
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.retryAfterSec).toBeGreaterThan(0);
  });

  test('a different identity keeps its own degraded bucket', async () => {
    const l = limiter(unreachableRedis(), 1);
    expect((await l.tryConsume(req('2.2.2.2'))).ok).toBe(true);
    expect((await l.tryConsume(req('2.2.2.2'))).ok).toBe(false);
    expect((await l.tryConsume(req('3.3.3.3'))).ok).toBe(true);
  });
});

describe('a Redis that rejects', () => {
  test('an error degrades the same way a timeout does', async () => {
    // A connection with a numeric `maxRetriesPerRequest` produces this shape
    // instead, and it must not surface as a 500 on a route that never asked
    // for Redis.
    const l = limiter(rejectingRedis(), 1);
    expect((await l.tryConsume(req('4.4.4.4'))).ok).toBe(true);
    expect((await l.tryConsume(req('4.4.4.4'))).ok).toBe(false);
  });
});

describe('a healthy Redis is unaffected', () => {
  test('the fallback does not double-count when Redis answers', async () => {
    const counts: Record<string, number> = {};
    const redis = {
      incrby: async (key: string, amount: number) => {
        counts[key] = (counts[key] ?? 0) + amount;
        return counts[key];
      },
      expire: async () => 1,
    } as unknown as Redis;

    const l = limiter(redis, 2);
    expect((await l.tryConsume(req('5.5.5.5'))).ok).toBe(true);
    expect((await l.tryConsume(req('5.5.5.5'))).ok).toBe(true);
    expect((await l.tryConsume(req('5.5.5.5'))).ok).toBe(false);
    // Three calls, three round trips — the in-memory bucket never ran.
    expect(Object.values(counts)).toEqual([3]);
  });
});

describe('the fixed window is pinned, not merely wide (SC-256)', () => {
  test('two degraded calls share a bucket even 5ms before a minute rolls', async () => {
    // The exact instant that produced the flake. Unpinned, the first call
    // falls in windowStart=N and the second — 20ms later, after its timeout
    // elapses — in N+60, so both admit under `max: 1` and the assertion
    // below reads `true` where it wants `false`.
    //
    // With `Date.now()` frozen the second call cannot cross, whatever the
    // real elapsed time. This is the regression guard: it fails if anyone
    // removes the pin, and it does not depend on when the suite happens to
    // run.
    setSystemTime(new Date('2026-08-15T12:00:59.995Z'));
    const l = limiter(unreachableRedis(), 1);

    expect((await l.tryConsume(req('7.7.7.7'))).ok).toBe(true);
    expect((await l.tryConsume(req('7.7.7.7'))).ok).toBe(false);
  });
});
