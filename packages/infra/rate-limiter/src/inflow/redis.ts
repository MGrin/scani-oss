import type { Redis } from 'ioredis';
import { InflowRateLimiter, type InflowRateLimiterOptions } from './inflow-rate-limiter';

/**
 * Redis-backed inflow limiter. Bucket key is
 * `<namespace>:<identity>:<windowStart>` — separate windows trivially
 * partition, and EXPIRE handles cleanup so we never need a sweeper.
 */
export class RedisInflowRateLimiter extends InflowRateLimiter {
  private readonly redis: Redis;

  constructor(redis: Redis, opts: InflowRateLimiterOptions) {
    super(opts);
    this.redis = redis;
  }

  protected async incrementCounter(
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
}
