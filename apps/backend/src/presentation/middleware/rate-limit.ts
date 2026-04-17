import type { Redis } from 'ioredis';

type KeyFunc = (req: Request) => string;

/**
 * Request-origin keying for rate limits.
 *
 * Prefers the forwarded-for headers Fly sets (cf-connecting-ip then
 * x-forwarded-for); falls back to a UA+origin+method signature when the
 * client comes in via a non-proxied path.
 */
function defaultKeyFn(req: Request): string {
  const h = req.headers;
  return (
    h.get('x-forwarded-for') ||
    h.get('cf-connecting-ip') ||
    h.get('x-real-ip') ||
    `${h.get('user-agent') || 'ua'}|${h.get('origin') || 'origin'}|${req.method}`
  );
}

interface RedisRateLimiterOptions {
  windowMs: number;
  max: number;
  namespace: string; // key prefix, e.g. 'rl:standard' — keep distinct per limiter
  key?: KeyFunc;
}

/**
 * Redis-backed fixed-window counter.
 *
 * INCR + EXPIRE is atomic, the key is window-rounded so it self-resets on
 * window boundaries, and multiple backend instances share the bucket via
 * the single Redis. Less precise than a token bucket (no burst smoothing,
 * sharp reset at window edges), but trivially coherent across machines.
 */
export class RateLimiter {
  private readonly windowSec: number;
  private readonly max: number;
  private readonly namespace: string;
  private readonly keyFn: KeyFunc;
  private readonly redis: Redis;

  constructor(redis: Redis, opts: RedisRateLimiterOptions) {
    this.redis = redis;
    this.windowSec = Math.max(1, Math.floor(opts.windowMs / 1000));
    this.max = Math.max(1, opts.max);
    this.namespace = opts.namespace;
    this.keyFn = opts.key || defaultKeyFn;
  }

  async tryConsume(
    req: Request,
    tokens = 1
  ): Promise<{ ok: true } | { ok: false; retryAfterSec: number }> {
    const identity = this.keyFn(req);
    const nowSec = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(nowSec / this.windowSec) * this.windowSec;
    const redisKey = `${this.namespace}:${identity}:${windowStart}`;
    const count = await this.redis.incrby(redisKey, tokens);
    if (count === tokens) {
      // First hit in this window; set expiry.
      await this.redis.expire(redisKey, this.windowSec);
    }
    if (count <= this.max) {
      return { ok: true };
    }
    const retryAfterSec = windowStart + this.windowSec - nowSec;
    return { ok: false, retryAfterSec: Math.max(1, retryAfterSec) };
  }
}

// Utility factories for common limiters. Keep the names the callers
// already use.
export const createStandardLimiter = (perMinute = 120, _burst = 200, redis: Redis) =>
  new RateLimiter(redis, { windowMs: 60_000, max: perMinute, namespace: 'rl:standard' });

export const createStrictLimiter = (perMinute = 20, _burst = 30, redis: Redis) =>
  new RateLimiter(redis, { windowMs: 60_000, max: perMinute, namespace: 'rl:strict' });
