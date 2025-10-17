type KeyFunc = (req: Request) => string;

interface RateLimiterOptions {
  windowMs: number; // refill window in ms
  max: number; // tokens per window
  burst?: number; // optional burst capacity (defaults to max)
  key?: KeyFunc; // how to key buckets (default by IP)
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private windowMs: number;
  private max: number;
  private burst: number;
  private keyFn: KeyFunc;
  private buckets = new Map<string, Bucket>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(opts: RateLimiterOptions) {
    this.windowMs = Math.max(1000, opts.windowMs);
    this.max = Math.max(1, opts.max);
    this.burst = Math.max(this.max, opts.burst ?? opts.max);
    this.keyFn =
      opts.key ||
      ((req: Request) => {
        // Fallback to IP via forwarded headers; otherwise, user agent + origin + method as rough key
        const h = req.headers;
        return (
          h.get('x-forwarded-for') ||
          h.get('cf-connecting-ip') ||
          h.get('x-real-ip') ||
          `${h.get('user-agent') || 'ua'}|${h.get('origin') || 'origin'}|${req.method}`
        );
      });

    this.cleanupInterval = setInterval(() => {
      this.cleanupBuckets();
    }, this.windowMs);

    if (typeof this.cleanupInterval.unref === 'function') {
      this.cleanupInterval.unref();
    }
  }

  private refill(bucket: Bucket) {
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;
    if (elapsed <= 0) return;
    const tokensToAdd = (elapsed / this.windowMs) * this.max;
    bucket.tokens = Math.min(this.burst, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
  }

  tryConsume(req: Request, tokens = 1): { ok: true } | { ok: false; retryAfterSec: number } {
    const key = this.keyFn(req);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.burst, lastRefill: Date.now() };
      this.buckets.set(key, bucket);
    }
    this.refill(bucket);
    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens;
      return { ok: true };
    }
    const deficit = tokens - bucket.tokens;
    const ratePerMs = this.max / this.windowMs;
    const retryAfterMs = Math.ceil(deficit / ratePerMs);
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    };
  }

  private cleanupBuckets() {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > this.windowMs) {
        this.buckets.delete(key);
      }
    }
  }
}

// Utility factory for common limiters
export const createStandardLimiter = (perMinute = 120, burst = 200) =>
  new RateLimiter({ windowMs: 60_000, max: perMinute, burst });

export const createStrictLimiter = (perMinute = 20, burst = 30) =>
  new RateLimiter({ windowMs: 60_000, max: perMinute, burst });
