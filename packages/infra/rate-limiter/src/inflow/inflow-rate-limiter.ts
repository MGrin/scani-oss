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
 * Request-origin keying. Trust edge-provider headers
 * (`cf-connecting-ip` for Cloudflare, `fly-client-ip` for Fly,
 * `x-real-ip` for generic proxies) — those are set by trusted infra
 * and overwritten at the edge, so clients can't forge them.
 *
 * `X-Forwarded-For` is only used as a last-resort fallback and only
 * the **rightmost** entry is trusted: Fly and Cloudflare APPEND the
 * real client IP at the tail, so the leftmost values are
 * attacker-controlled. If we keyed on the whole list a caller could
 * rotate a random prefix and trivially bypass the counter.
 */
export function defaultInflowKey(req: Request): string {
  const h = req.headers;
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
    this.keyFn = opts.key ?? defaultInflowKey;
  }

  async tryConsume(
    req: Request,
    tokens = 1
  ): Promise<{ ok: true } | { ok: false; retryAfterSec: number }> {
    const identity = this.keyFn(req);
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
