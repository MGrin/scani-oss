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
}

/**
 * Redis-backed sliding-window outflow limiter. Every replica that
 * shares this Redis sees a coherent budget, which is the whole point —
 * an in-memory limiter at 7 rps per worker × 4 workers makes upstream
 * see 28 rps and the provider 429s.
 */
export class RedisOutflowRateLimiter extends OutflowRateLimiter {
  private readonly redis: Redis;
  private readonly namespace: string;

  constructor(opts: RedisOutflowRateLimiterOptions) {
    super(opts.maxRequests, opts.windowMs);
    this.redis = opts.redis;
    this.namespace = opts.namespace;
  }

  protected async tryAcquire(subKey?: string): Promise<number> {
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

  private redisKey(subKey?: string): string {
    return subKey ? `rl:${this.namespace}:${subKey}` : `rl:${this.namespace}`;
  }
}
