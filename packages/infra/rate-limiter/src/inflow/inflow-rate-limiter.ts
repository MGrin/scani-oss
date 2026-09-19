import { loadRateLimiterConfig, type RateLimiterConfig } from '../config';
import { cameThroughEdge } from '../edge';

// Fixed-window admission limiter for *inbound* HTTP requests. Distinct
// from the outflow family: the contract here is `tryConsume(req)` returning
// `{ ok, retryAfterSec }`, so the HTTP layer can reject up-front with a
// 429 + Retry-After header.
//
// Why fixed-window: INCR+EXPIRE is atomic and trivially coherent across
// instances. We accept the worst case of 2× the limit at a window
// boundary — at HTTP admission scale that's not the failure mode that
// matters; the smoothing of a sliding window is a luxury here.

export type InflowKeyFn = (req: Request) => string;

export interface InflowRateLimiterOptions {
  windowMs: number;
  max: number;
  /** Storage namespace — keep distinct per limiter (e.g. `rl:standard`). */
  namespace: string;
  /** Custom keying function (default: IP from edge proxy headers). */
  key?: InflowKeyFn;
}

/**
 * Request-origin keying.
 *
 * **On Fly, only `fly-client-ip` counts** (SC-1262). Fly's proxy sets that
 * header itself; every other header here arrives from the client untouched,
 * because nothing else sits in front of a Fly-direct app. Trusting
 * `cf-connecting-ip` first let a caller rotate it per request and walk past
 * every per-IP cap — about a thousand sign-in attempts a minute against a
 * 6-an-hour limit, 2026-09-19. A request with no `fly-client-ip` (a probe
 * from inside the private network) shares one bucket rather than falling
 * through to a header the client chose.
 *
 * Off Fly the edge headers are tried in order, and `X-Forwarded-For` only by
 * its **rightmost** entry, which is the one a proxy appended. If an app on Fly
 * is ever put behind Cloudflare's proxy, `fly-client-ip` becomes Cloudflare's
 * address; a valid `x-scani-edge` header marks exactly those requests.
 */
export function defaultInflowKey(
  req: Request,
  config: RateLimiterConfig = loadRateLimiterConfig()
): string {
  const h = req.headers;
  // Past Cloudflare (SC-1264), `fly-client-ip` is Cloudflare's address and the
  // client's is in `cf-connecting-ip`, which Cloudflare overwrites.
  if (cameThroughEdge(req, config)) return h.get('cf-connecting-ip') || 'edge:no-client-ip';
  if (config.FLY_APP_NAME) return h.get('fly-client-ip') || 'fly:no-client-ip';
  return (
    h.get('cf-connecting-ip') ||
    h.get('fly-client-ip') ||
    h.get('x-real-ip') ||
    extractXffTail(h.get('x-forwarded-for')) ||
    `${h.get('user-agent') || 'ua'}|${h.get('origin') || 'origin'}|${req.method}`
  );
}

export function extractXffTail(value: string | null): string | null {
  if (!value) return null;
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? (parts[parts.length - 1] ?? null) : null;
}

export abstract class InflowRateLimiter {
  protected readonly windowSec: number;
  protected readonly max: number;
  protected readonly namespace: string;
  protected readonly keyFn: InflowKeyFn;

  constructor(opts: InflowRateLimiterOptions) {
    this.windowSec = Math.max(1, Math.floor(opts.windowMs / 1000));
    this.max = Math.max(1, opts.max);
    this.namespace = opts.namespace;
    this.keyFn = opts.key ?? ((req) => defaultInflowKey(req));
  }

  async tryConsume(
    req: Request,
    tokens = 1
  ): Promise<{ ok: true } | { ok: false; retryAfterSec: number }> {
    return this.tryConsumeKey(this.keyFn(req), tokens);
  }

  /**
   * Same as `tryConsume` but the caller supplies the identity directly
   * instead of having it derived from a `Request`. Use this when the
   * route handler already knows the identity it wants to rate-limit on
   * (e.g. `ctx.userId` inside a tRPC mutation) and constructing a
   * fabricated `Request` just to satisfy the header-based `keyFn`
   * would be ceremony for nothing.
   */
  async tryConsumeKey(
    identity: string,
    tokens = 1
  ): Promise<{ ok: true } | { ok: false; retryAfterSec: number }> {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(nowSec / this.windowSec) * this.windowSec;
    const count = await this.incrementCounter(identity, windowStart, tokens);
    if (count <= this.max) return { ok: true };
    return { ok: false, retryAfterSec: Math.max(1, windowStart + this.windowSec - nowSec) };
  }

  /**
   * Atomic increment-and-return-new-value. The fresh-bucket case (when
   * the returned count equals `tokens`) is the subclass's signal to set
   * an expiry equal to the window length so old buckets get cleaned up.
   */
  protected abstract incrementCounter(
    identity: string,
    windowStart: number,
    tokens: number
  ): Promise<number>;
}
