import { InflowRateLimiter } from './inflow-rate-limiter';

interface BucketEntry {
  count: number;
  expiresAtSec: number;
}

/**
 * In-process inflow limiter. Suitable for single-instance dev / OSS
 * self-host. Multi-instance deployments must use `RedisInflowRateLimiter`
 * so every replica shares one bucket per identity.
 */
export class InMemoryInflowRateLimiter extends InflowRateLimiter {
  private readonly buckets = new Map<string, BucketEntry>();

  protected async incrementCounter(
    identity: string,
    windowStart: number,
    tokens: number
  ): Promise<number> {
    this.evictExpired(windowStart);
    const key = `${identity}:${windowStart}`;
    const existing = this.buckets.get(key);
    const next = (existing?.count ?? 0) + tokens;
    this.buckets.set(key, { count: next, expiresAtSec: windowStart + this.windowSec });
    return next;
  }

  // Sweep expired buckets opportunistically on each call so the map
  // doesn't grow unbounded for high-cardinality identities (every IP
  // gets its own bucket, and dev hosts can churn through many in a day).
  private evictExpired(nowSec: number): void {
    for (const [k, v] of this.buckets) {
      if (v.expiresAtSec <= nowSec) this.buckets.delete(k);
    }
  }
}
