/**
 * `RateLimiter` — in-memory queue-based limiter for single-process use.
 *
 * **Do not instantiate this directly in production code.** Multi-worker
 * deployments share upstream API budgets across instances, and per-process
 * limiters let 4 workers collectively exceed a 7rps provider budget by 4x.
 * Use `RedisRateLimiter` (same `execute(fn)` interface) when a Redis
 * client is available, and fall through to this only in tests or truly
 * single-process contexts.
 *
 * The `createRateLimiter(...)` factory at the bottom of this file picks
 * the right implementation based on whether a Redis instance is supplied.
 *
 * @example
 * ```typescript
 * const limiter = new RateLimiter(50, 60 * 1000); // 50 requests per minute
 * const result = await limiter.execute(() => fetch('https://api.example.com'));
 * ```
 */
export interface RateLimiterOptions {
  /**
   * Stable identifier shared across workers. Required when Redis has
   * been initialized via `initializeRateLimiterRedis(...)` — the limiter
   * routes through Redis under this namespace.
   */
  namespace?: string;
}

export class RateLimiter implements IRateLimiter {
  // Per-subKey queues for the in-memory fallback. `'__'` is the default
  // bucket when no subKey is supplied (preserves pre-subKey behaviour).
  private readonly queues = new Map<string, Array<() => void>>();
  private readonly requestTimes = new Map<string, number[]>();
  private readonly processing = new Set<string>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  /** Delegate to Redis-backed limiter when a global Redis instance is set. */
  private readonly delegate: IRateLimiter | null;

  /**
   * Create a rate limiter. If `initializeRateLimiterRedis` has been
   * called and `options.namespace` is provided, the instance delegates
   * to a Redis-backed sliding window that multi-worker deployments can
   * share. Otherwise it falls through to the in-memory queue.
   */
  constructor(maxRequests: number, windowMs: number, options: RateLimiterOptions = {}) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    if (sharedRedis && options.namespace) {
      // Lazy require so the ioredis type isn't hoisted into contexts
      // that never touch Redis (tests, landing-page bundles).
      const { RedisRateLimiter } = require('./redis-rate-limiter') as {
        RedisRateLimiter: new (o: {
          redis: RedisLike;
          namespace: string;
          maxRequests: number;
          windowMs: number;
        }) => IRateLimiter;
      };
      this.delegate = new RedisRateLimiter({
        redis: sharedRedis,
        namespace: options.namespace,
        maxRequests,
        windowMs,
      });
    } else {
      this.delegate = null;
    }
  }

  /**
   * Execute a function with rate limiting. `subKey` partitions the bucket
   * — callers with different subKeys get independent sliding windows. We
   * use this to enforce per-credential limits (hashed API key) so one
   * user's Binance/IBKR/etc. traffic doesn't starve another's and so
   * provider-side per-token limits (IBKR Flex 1018) stay accurate.
   */
  async execute<T>(fn: () => Promise<T>, subKey?: string): Promise<T> {
    if (this.delegate) return this.delegate.execute(fn, subKey);
    const bucket = subKey ?? '__';
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(bucket) ?? [];
      queue.push(async () => {
        try {
          resolve(await fn());
        } catch (error) {
          reject(error);
        }
      });
      this.queues.set(bucket, queue);
      this.processQueue(bucket);
    });
  }

  private processQueue(bucket: string): void {
    if (this.processing.has(bucket)) return;
    const queue = this.queues.get(bucket);
    if (!queue || queue.length === 0) return;
    this.processing.add(bucket);

    const now = Date.now();
    const times = (this.requestTimes.get(bucket) ?? []).filter((t) => now - t < this.windowMs);
    const availableSlots = this.maxRequests - times.length;

    if (availableSlots > 0) {
      const batchSize = Math.min(availableSlots, queue.length);
      const batch: Array<() => void> = [];
      for (let i = 0; i < batchSize; i++) {
        const next = queue.shift();
        if (next) {
          batch.push(next);
          times.push(now);
        }
      }
      this.requestTimes.set(bucket, times);
      for (const request of batch) request();
      this.processing.delete(bucket);
      setTimeout(() => this.processQueue(bucket), 0);
    } else {
      const oldest = times[0];
      this.requestTimes.set(bucket, times);
      if (oldest) {
        const waitTime = Math.max(1, this.windowMs - (now - oldest) + 100);
        this.processing.delete(bucket);
        setTimeout(() => this.processQueue(bucket), waitTime);
      } else {
        this.processing.delete(bucket);
      }
    }
  }
}

/**
 * Rate limiter interface type for dependency injection.
 *
 * `subKey` partitions the bucket — callers with different subKeys use
 * independent sliding windows. Leaving it undefined keeps the legacy
 * single-bucket-per-namespace behaviour.
 */
export type IRateLimiter = {
  execute<T>(fn: () => Promise<T>, subKey?: string): Promise<T>;
};

/**
 * Derive a stable, short, non-reversible key from a raw credential so it
 * can safely be used as a Redis bucket partition. Raw API keys must never
 * become a Redis key (the infra logs keys + the value is highly sensitive).
 * 12 hex chars = 48 bits ≈ zero collision risk at Scani's scale.
 */
export function credentialBucketKey(raw: string): string {
  // crypto.subtle is sync-unsafe — use node:crypto directly. The lazy
  // require avoids pulling node:crypto into any bundle that doesn't call
  // this (browser, tests).
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(raw.trim()).digest('hex').slice(0, 12);
}

export {
  createStandardLimiter,
  createStrictLimiter,
  HttpAdmissionRateLimiter,
  type HttpAdmissionRateLimiterOptions,
} from './http-admission';
export { RedisRateLimiter, type RedisRateLimiterOptions } from './redis-rate-limiter';

// Global Redis handle — set once at app boot by the backend/worker. Every
// `new RateLimiter(max, ms, { namespace })` constructed after this point
// routes through Redis so the limit is coherent across processes.
let sharedRedis: RedisLike | null = null;

/**
 * Wire a Redis client into the rate-limiter module. Call once at boot
 * before any rate-limited code path runs. Subsequent `new RateLimiter(...)`
 * calls that provide a `namespace` will delegate to Redis.
 *
 * Idempotent — calling with the same instance is a no-op; calling with
 * a different instance replaces the handle (useful for tests).
 */
export function initializeRateLimiterRedis(redis: RedisLike): void {
  sharedRedis = redis;
}

/** Tear down the Redis handle (tests + graceful shutdown). */
export function resetRateLimiterRedis(): void {
  sharedRedis = null;
}

/**
 * Factory — returns a Redis-backed limiter when a Redis client is supplied,
 * else falls through to the in-memory one. Centralising the choice here
 * means callers pass the optional `redis` along and get the right
 * implementation without knowing the details.
 */
// biome-ignore lint/suspicious/noExplicitAny: Redis type lives in ioredis; we use a structural shape.
type RedisLike = any;

export function createRateLimiter(opts: {
  maxRequests: number;
  windowMs: number;
  redis?: RedisLike;
  /** Stable identifier shared across workers when `redis` is provided. */
  namespace?: string;
}): IRateLimiter {
  if (opts.redis) {
    if (!opts.namespace) {
      throw new Error('createRateLimiter: `namespace` is required when `redis` is provided');
    }
    // Lazy-import to avoid bundling the Redis branch into contexts that
    // never use it.
    const { RedisRateLimiter } = require('./redis-rate-limiter') as {
      RedisRateLimiter: new (o: {
        redis: RedisLike;
        namespace: string;
        maxRequests: number;
        windowMs: number;
      }) => IRateLimiter;
    };
    return new RedisRateLimiter({
      redis: opts.redis,
      namespace: opts.namespace,
      maxRequests: opts.maxRequests,
      windowMs: opts.windowMs,
    });
  }
  return new RateLimiter(opts.maxRequests, opts.windowMs);
}
