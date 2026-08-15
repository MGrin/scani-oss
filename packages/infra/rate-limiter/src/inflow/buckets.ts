interface BucketEntry {
  count: number;
  expiresAtSec: number;
}

/**
 * Fixed-window counters held in this process.
 *
 * Extracted from `InMemoryInflowRateLimiter` so the Redis limiter can share it
 * as a degraded path (SC-225) rather than reaching into a sibling's protected
 * method or growing a second copy of the same six lines.
 */
export class InMemoryBuckets {
  private readonly buckets = new Map<string, BucketEntry>();

  increment(identity: string, windowStart: number, windowSec: number, tokens: number): number {
    this.evictExpired(windowStart);
    const key = `${identity}:${windowStart}`;
    const existing = this.buckets.get(key);
    const next = (existing?.count ?? 0) + tokens;
    this.buckets.set(key, { count: next, expiresAtSec: windowStart + windowSec });
    return next;
  }

  // Sweep expired buckets opportunistically on each call so the map doesn't
  // grow unbounded for high-cardinality identities (every IP gets its own
  // bucket, and dev hosts can churn through many in a day).
  private evictExpired(nowSec: number): void {
    for (const [k, v] of this.buckets) {
      if (v.expiresAtSec <= nowSec) this.buckets.delete(k);
    }
  }
}
