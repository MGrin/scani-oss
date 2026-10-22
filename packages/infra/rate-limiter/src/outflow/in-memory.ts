import { OutflowRateLimiter, PRIORITY_YIELD_MS } from './outflow-rate-limiter';

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
  /** Per bucket, each waiting `high` caller and when its claim lapses. */
  private readonly waiters = new Map<string, Map<string, number>>();

  protected async tryAcquire(subKey?: string, highWaiter?: string): Promise<number> {
    const bucket = subKey ?? DEFAULT_BUCKET;
    const now = Date.now();
    const recent = (this.buckets.get(bucket) ?? []).filter((t) => now - t < this.windowMs);
    const waiting = this.waiters.get(bucket) ?? new Map<string, number>();
    for (const [id, until] of waiting) if (until <= now) waiting.delete(id);
    this.waiters.set(bucket, waiting);

    if (highWaiter) waiting.set(highWaiter, now + this.windowMs + 1000);
    else if (waiting.size > 0) {
      this.buckets.set(bucket, recent);
      return PRIORITY_YIELD_MS;
    }

    if (recent.length < this.maxRequests) {
      recent.push(now);
      this.buckets.set(bucket, recent);
      if (highWaiter) waiting.delete(highWaiter);
      return 0;
    }

    this.buckets.set(bucket, recent);
    const oldest = recent[0];
    if (oldest === undefined) return 0;
    return Math.max(1, this.windowMs - (now - oldest));
  }
}
