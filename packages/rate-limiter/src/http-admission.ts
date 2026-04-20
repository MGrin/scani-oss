/**
 * Redis-backed fixed-window counter for HTTP request admission.
 *
 * Distinct from the `RateLimiter` / `RedisRateLimiter` in this package
 * (those are sliding-window `execute(fn)` throttles for per-provider
 * operation budgets — CoinGecko, Etherscan, etc.). This limiter takes
 * a `Request` and returns `{ ok, retryAfterSec }` so the HTTP layer can
 * reject upfront with a 429 + Retry-After header.
 *
 * Why fixed-window instead of sliding: INCR + EXPIRE is atomic in Redis
 * and trivially coherent across instances. We lose burst-smoothing at
 * window edges, but for HTTP admission that's acceptable — the worst
 * case is 2× the limit spanning a window boundary, not infinite fan-out.
 */

// biome-ignore lint/suspicious/noExplicitAny: Redis type lives in ioredis; using a structural shape keeps this file optional-deps-safe.
type RedisLike = any;

type KeyFunc = (req: Request) => string;

/**
 * Request-origin keying. Prefer the edge-provider headers (`cf-connecting-ip`
 * for Cloudflare, `fly-client-ip` for Fly, `x-real-ip` for generic proxies)
 * — those are set by trusted infra and overwritten at the edge, so clients
 * can't forge them.
 *
 * `X-Forwarded-For` is only used as a last-resort fallback and only the
 * **rightmost** entry is trusted: Fly and Cloudflare APPEND the real client
 * IP at the tail, so the leftmost values are attacker-controlled. If we
 * keyed on the whole list a caller could rotate a random prefix
 * (`x-forwarded-for: <random>, <real-ip>`) and trivially bypass the counter
 * — every hit would land in a fresh Redis bucket that resets the limit.
 *
 * The final fallback (UA+origin+method) is intentionally coarse — non-
 * proxied traffic is rare in production; in dev the whole admission layer
 * is usually behind Redis being reachable anyway.
 */
function extractXffTail(value: string | null): string | null {
  if (!value) return null;
  // Rightmost non-empty entry is the hop closest to our edge.
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts[parts.length - 1]! : null;
}

function defaultKeyFn(req: Request): string {
  const h = req.headers;
  return (
    h.get('cf-connecting-ip') ||
    h.get('fly-client-ip') ||
    h.get('x-real-ip') ||
    extractXffTail(h.get('x-forwarded-for')) ||
    `${h.get('user-agent') || 'ua'}|${h.get('origin') || 'origin'}|${req.method}`
  );
}

export interface HttpAdmissionRateLimiterOptions {
  windowMs: number;
  max: number;
  /** Redis key prefix — keep distinct per limiter (e.g. `rl:standard`). */
  namespace: string;
  /** Custom keying function (by default: IP from proxy headers). */
  key?: KeyFunc;
}

export class HttpAdmissionRateLimiter {
  private readonly windowSec: number;
  private readonly max: number;
  private readonly namespace: string;
  private readonly keyFn: KeyFunc;
  private readonly redis: RedisLike;

  constructor(redis: RedisLike, opts: HttpAdmissionRateLimiterOptions) {
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

// Common factory presets. Names match the original backend callers to
// minimise migration churn.
export const createStandardLimiter = (redis: RedisLike, perMinute = 120) =>
  new HttpAdmissionRateLimiter(redis, {
    windowMs: 60_000,
    max: perMinute,
    namespace: 'rl:standard',
  });

export const createStrictLimiter = (redis: RedisLike, perMinute = 20) =>
  new HttpAdmissionRateLimiter(redis, {
    windowMs: 60_000,
    max: perMinute,
    namespace: 'rl:strict',
  });
