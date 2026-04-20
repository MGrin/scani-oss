/**
 * Redis-backed sliding-window rate limiter with "queue and wait" semantics.
 *
 * Why this exists: multi-worker deployments need a SHARED rate-limit budget
 * for upstream APIs (Etherscan, CoinGecko, etc.) — an in-memory limiter at
 * 7rps per worker with 4 workers in prod means Etherscan actually sees
 * 28rps and the provider-side 429s start. Redis gives every instance of
 * the backend/worker a coherent view of the budget.
 *
 * Implementation: a Lua-scripted sliding window on a sorted set.
 *   - Each permitted request appends its timestamp to `ZADD key now now`.
 *   - The script `ZREMRANGEBYSCORE key -inf (now - windowMs)` evicts old
 *     entries, then checks `ZCARD` to see how many fit in the window.
 *   - If under `max`, grant immediately. Else return the wait delta until
 *     the oldest entry expires — caller sleeps and retries.
 *
 * Interface-compatible with the in-memory `RateLimiter.execute(fn)`, so
 * callers swap implementations without code changes beyond the factory.
 */

import type { Redis } from 'ioredis';
import type { IRateLimiter } from './index';

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

export interface RedisRateLimiterOptions {
  redis: Redis;
  /** Redis key suffix — must be stable across workers. e.g. `etherscan`. */
  namespace: string;
  /** Max requests allowed within the window. */
  maxRequests: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export class RedisRateLimiter implements IRateLimiter {
  private readonly redis: Redis;
  private readonly namespace: string;
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(opts: RedisRateLimiterOptions) {
    this.redis = opts.redis;
    this.namespace = opts.namespace;
    this.maxRequests = opts.maxRequests;
    this.windowMs = opts.windowMs;
  }

  /**
   * When `subKey` is provided the Redis bucket key becomes
   * `rl:{namespace}:{subKey}` — two callers with different subKeys get
   * independent sliding windows. This is how we partition per-credential
   * (one bucket per API key) so provider-side per-token limits (e.g. IBKR
   * Flex 1018) don't cause cross-user collisions in Scani's shared
   * provider namespace.
   */
  async execute<T>(fn: () => Promise<T>, subKey?: string): Promise<T> {
    await this.waitForSlot(subKey);
    return fn();
  }

  private async waitForSlot(subKey?: string): Promise<void> {
    while (true) {
      const waitMs = await this.tryAcquire(subKey);
      if (waitMs === 0) return;
      // Add a tiny jitter so colliding workers don't all wake up at the
      // exact same millisecond and re-race.
      await new Promise((r) => setTimeout(r, waitMs + Math.floor(Math.random() * 25)));
    }
  }

  private redisKey(subKey?: string): string {
    return subKey ? `rl:${this.namespace}:${subKey}` : `rl:${this.namespace}`;
  }

  private async tryAcquire(subKey?: string): Promise<number> {
    const now = Date.now();
    // biome-ignore lint/suspicious/noExplicitAny: ioredis `eval` return type is `unknown`.
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
}
