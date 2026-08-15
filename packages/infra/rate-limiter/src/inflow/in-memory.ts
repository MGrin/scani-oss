import { InMemoryBuckets } from './buckets';
import { InflowRateLimiter } from './inflow-rate-limiter';

/**
 * In-process inflow limiter. Suitable for single-instance dev / OSS
 * self-host. Multi-instance deployments must use `RedisInflowRateLimiter`
 * so every replica shares one bucket per identity.
 */
export class InMemoryInflowRateLimiter extends InflowRateLimiter {
  private readonly buckets = new InMemoryBuckets();

  protected async incrementCounter(
    identity: string,
    windowStart: number,
    tokens: number
  ): Promise<number> {
    return this.buckets.increment(identity, windowStart, this.windowSec, tokens);
  }
}
