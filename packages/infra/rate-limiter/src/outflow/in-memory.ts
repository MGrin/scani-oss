import { OutflowRateLimiter } from './outflow-rate-limiter';

const DEFAULT_BUCKET = '__';

/**
 * In-process sliding-window outflow limiter.
 *
 * Suitable for tests and truly single-process deployments. Multi-worker
 * deployments must use `RedisOutflowRateLimiter` so every replica shares
 * one upstream-API budget — otherwise N workers collectively exceed a
 * provider's per-key cap by ×N.
 */
export class InMemoryOutflowRateLimiter extends OutflowRateLimiter {
  private readonly buckets = new Map<string, number[]>();

  protected async tryAcquire(subKey?: string): Promise<number> {
    const bucket = subKey ?? DEFAULT_BUCKET;
    const now = Date.now();
    const recent = (this.buckets.get(bucket) ?? []).filter((t) => now - t < this.windowMs);

    if (recent.length < this.maxRequests) {
      recent.push(now);
      this.buckets.set(bucket, recent);
      return 0;
    }

    this.buckets.set(bucket, recent);
    const oldest = recent[0];
    if (oldest === undefined) return 0;
    return Math.max(1, this.windowMs - (now - oldest));
  }
}
