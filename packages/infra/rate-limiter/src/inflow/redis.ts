import type { Redis } from 'ioredis';
import { InMemoryBuckets } from './buckets';
import { InflowRateLimiter, type InflowRateLimiterOptions } from './inflow-rate-limiter';

export interface RedisInflowRateLimiterOptions extends InflowRateLimiterOptions {
  /**
   * How long to wait for Redis before counting in this process instead.
   * Production Redis sits on Fly's 6PN and answers in ~1ms, so the default
   * is ~250x the happy path — it engages on an outage, never on load.
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 250;

/**
 * Redis-backed inflow limiter. Bucket key is
 * `<namespace>:<identity>:<windowStart>` — separate windows trivially
 * partition, and EXPIRE handles cleanup so we never need a sweeper.
 *
 * **Bounded, and degrades rather than blocks (SC-225).** This limiter runs in
 * `onBeforeHandle` for every request the api serves, including `/health` —
 * which Fly gates traffic on. So the time it is willing to wait for Redis is
 * the time the whole app is willing to be unreachable for.
 *
 * On 2026-08-15 that was forever. `api.scani.xyz` was down 14 minutes because
 * deploying the worker replaced the machine Redis lives inside, and the api's
 * shared connection is built with `maxRetriesPerRequest: null`. In ioredis
 * 5.10.1 that option is only honoured `if (typeof maxRetriesPerRequest ===
 * "number")` (`built/redis/event_handler.js:199`), so the queue-flush branch
 * never runs and a queued command is never rejected. Verified against a real
 * client on a dead port: still pending after 4000ms, where
 * `maxRetriesPerRequest: 1` rejects with `MaxRetriesPerRequestError`.
 *
 * Fly's check therefore did not receive a 503 — it received nothing, timed
 * out, and pulled both machines from the load balancer over a dependency the
 * probe never touches.
 *
 * **Degraded, not open.** Failing open would hand an attacker an unlimited
 * budget the moment Redis blinks, and the whole point of the shared store is
 * that N replicas share one bucket. Falling back to in-process counting keeps
 * the limit enforced per machine: the worst case is N x the configured limit
 * across N machines — two, today — for as long as Redis is away. That is a
 * bounded, temporary loss of precision instead of an outage.
 *
 * The timed-out command is NOT cancelled; ioredis has no such API and it stays
 * in the offline queue until the connection returns. That is deliberate — the
 * request stops waiting, the eventual write still lands.
 */
export class RedisInflowRateLimiter extends InflowRateLimiter {
  private readonly redis: Redis;
  private readonly timeoutMs: number;
  /** Only touched while Redis is unreachable. */
  private readonly fallback = new InMemoryBuckets();

  constructor(redis: Redis, opts: RedisInflowRateLimiterOptions) {
    super(opts);
    this.redis = redis;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  protected async incrementCounter(
    identity: string,
    windowStart: number,
    tokens: number
  ): Promise<number> {
    try {
      return await this.withTimeout(this.incrementInRedis(identity, windowStart, tokens));
    } catch {
      // Both shapes of the same outage land here: a hung command that timed
      // out, and a rejection from a connection that does bound its retries.
      // Neither is the caller's problem and neither may reach the route as a
      // 500 — a request that never asked for Redis must not fail on it.
      return this.fallback.increment(identity, windowStart, this.windowSec, tokens);
    }
  }

  private async incrementInRedis(
    identity: string,
    windowStart: number,
    tokens: number
  ): Promise<number> {
    const key = `${this.namespace}:${identity}:${windowStart}`;
    const count = await this.redis.incrby(key, tokens);
    if (count === tokens) {
      // First hit in this window — pin the expiry once.
      await this.redis.expire(key, this.windowSec);
    }
    return count;
  }

  private withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`rate-limiter: Redis did not answer in ${this.timeoutMs}ms`)),
        this.timeoutMs
      );
    });
    // `finally` clears the timer on the happy path too, or every admitted
    // request would hold a pending timeout for `timeoutMs`.
    return Promise.race([work, expiry]).finally(() => {
      if (timer) clearTimeout(timer);
    }) as Promise<T>;
  }
}
