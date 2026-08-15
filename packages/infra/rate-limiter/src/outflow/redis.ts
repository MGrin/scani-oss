import type { Redis } from 'ioredis';
import { OutflowRateLimiter } from './outflow-rate-limiter';

// Lua-scripted sliding window on a Redis sorted set.
//   - `ZREMRANGEBYSCORE` evicts entries older than `now - windowMs`.
//   - If `ZCARD < max`, append a new entry and grant the slot (return 0).
//   - Else return the wait delta until the oldest entry expires; the
//     caller sleeps and retries.
const ACQUIRE_SCRIPT = `
  local key = KEYS[1]
  local nowMs = tonumber(ARGV[1])
  local windowMs = tonumber(ARGV[2])
  local max = tonumber(ARGV[3])
  local cutoff = nowMs - windowMs
  redis.call('ZREMRANGEBYSCORE', key, '-inf', '(' .. cutoff)
  local count = redis.call('ZCARD', key)
  if count < max then
    redis.call('ZADD', key, nowMs, nowMs .. ':' .. math.random())
    redis.call('PEXPIRE', key, windowMs)
    return 0
  end
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  if #oldest < 2 then
    return 0
  end
  local wait = (tonumber(oldest[2]) + windowMs) - nowMs
  if wait < 1 then return 1 end
  return wait
`;

export interface RedisOutflowRateLimiterOptions {
  redis: Redis;
  /** Redis key suffix — must be stable across workers. e.g. `etherscan`. */
  namespace: string;
  maxRequests: number;
  windowMs: number;
  /**
   * How long to wait for Redis before giving up on the slot. Production
   * Redis sits on Fly's 6PN and answers in ~1ms, so the default is ~250x the
   * happy path — it engages on an outage, never on load.
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 250;

/**
 * Raised when Redis could not tell us whether a slot was free.
 *
 * Distinct from an upstream failure on purpose: nothing was sent, so a caller
 * that retries is not re-sending a request the provider may already have
 * seen. `withRetry` and BullMQ's job retries both do the right thing with it.
 */
export class OutflowLimiterUnavailableError extends Error {
  readonly namespace: string;

  constructor(namespace: string, timeoutMs: number, cause?: unknown) {
    super(
      `rate-limiter: could not confirm an outflow slot for '${namespace}' within ${timeoutMs}ms — ` +
        'refusing the call rather than risking the upstream budget'
    );
    this.name = 'OutflowLimiterUnavailableError';
    this.namespace = namespace;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Redis-backed sliding-window outflow limiter. Every replica that
 * shares this Redis sees a coherent budget, which is the whole point —
 * an in-memory limiter at 7 rps per worker × 4 workers makes upstream
 * see 28 rps and the provider 429s.
 *
 * **Bounded, and fails CLOSED (SC-254).** The `eval` below used to be awaited
 * with no bound, on a connection built `{ maxRetriesPerRequest: null }`. In
 * ioredis 5.10.1 that option is only honoured `if (typeof
 * maxRetriesPerRequest === "number")` (`built/redis/event_handler.js:199`), so
 * the queue-flush branch never runs and a queued command is never rejected —
 * verified against a real client on a dead port: still pending after 4000ms.
 * The connection cannot be bounded at the client either, because BullMQ
 * asserts the option must be null, so the bound belongs here (SC-225).
 *
 * **Why this fails closed where the INFLOW limiter degrades.** They protect
 * opposite things, and the asymmetry is in who pays for being wrong.
 *
 * The inflow limiter protects *us* from callers. Degrading it to per-process
 * counting costs at most N x our own limit across N machines — self-inflicted,
 * bounded, and over the instant Redis returns. Failing closed there would take
 * the app off the load balancer, which is the outage it exists to prevent.
 *
 * This one protects *someone else's* API from us, under a cap we agreed to.
 * Degrading it to per-process counting is precisely the failure the class
 * docstring above names — 4 workers x 7 rps arriving as 28 — and the penalty
 * is not ours to bound: a 429 storm, a banned key, a blocked IP. That damage
 * is shared (one banned key breaks the feature for every user, not just the
 * request that caused it) and it can outlive the Redis outage by hours or
 * permanently. A key is not un-banned by Redis coming back.
 *
 * So the trade is: a failed call, which the callers already retry, against a
 * durable breach of a third party's limit, which nothing here can undo. The
 * reversible loss wins.
 *
 * **It throws rather than returning a wait.** Returning a non-zero delta would
 * look like fail-closed and be the original bug wearing a mask: `waitForSlot`
 * loops on any non-zero return, so a limiter that reported "wait" while Redis
 * was down would spin until it came back — a hang with a sleep in it. And it
 * must never return 0, which would tell the caller it holds a slot it does
 * not.
 *
 * The timed-out command is NOT cancelled; ioredis has no such API and it stays
 * queued until the connection returns. Harmless here: a stale ZADD lands in a
 * sliding window that has already moved past it.
 */
export class RedisOutflowRateLimiter extends OutflowRateLimiter {
  private readonly redis: Redis;
  private readonly namespace: string;
  private readonly timeoutMs: number;

  constructor(opts: RedisOutflowRateLimiterOptions) {
    super(opts.maxRequests, opts.windowMs);
    this.redis = opts.redis;
    this.namespace = opts.namespace;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  protected async tryAcquire(subKey?: string): Promise<number> {
    try {
      return await this.withTimeout(this.acquireInRedis(subKey));
    } catch (cause) {
      // Both shapes of the same outage arrive here — a command that hung past
      // the bound, and a rejection from a connection that does bound its
      // retries. Neither answers the only question that matters, so neither
      // may be turned into a slot.
      throw new OutflowLimiterUnavailableError(this.namespace, this.timeoutMs, cause);
    }
  }

  private async acquireInRedis(subKey?: string): Promise<number> {
    const now = Date.now();
    // biome-ignore lint/suspicious/noExplicitAny: ioredis `eval` returns `unknown`.
    const raw = (await (this.redis as any).eval(
      ACQUIRE_SCRIPT,
      1,
      this.redisKey(subKey),
      String(now),
      String(this.windowMs),
      String(this.maxRequests)
    )) as number | string;
    return typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  }

  private withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`rate-limiter: Redis did not answer in ${this.timeoutMs}ms`)),
        this.timeoutMs
      );
    });
    // `finally` clears the timer on the happy path too — `waitForSlot` calls
    // this in a loop, so a leaked timer per attempt would accumulate one per
    // acquisition for the whole window.
    return Promise.race([work, expiry]).finally(() => {
      if (timer) clearTimeout(timer);
    }) as Promise<T>;
  }

  private redisKey(subKey?: string): string {
    return subKey ? `rl:${this.namespace}:${subKey}` : `rl:${this.namespace}`;
  }
}
