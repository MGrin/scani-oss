/**
 * Global hourly cost circuit-breaker for upstream third-party APIs.
 *
 * The per-tenant quota in `middleware.ts` covers per-API-key request
 * counts. It does NOT protect against:
 *
 *   - A runaway loop in a single processor that bypasses the per-key
 *     rate-limit (e.g. screenshot-parse retrying on a malformed
 *     payload, each retry making fresh AI calls).
 *   - A misconfigured customer integration that hits N AI calls per
 *     user action, multiplied by N users.
 *   - A bug that classifies a non-fatal error as retryable and
 *     spams CoinGecko / Etherscan / OpenAI until the budget is gone.
 *
 * The breaker tracks a rolling 1-hour cumulative `upstreamCostUsd`
 * across ALL requests (org-wide, not per-tenant) in Redis. When
 * cumulative cost exceeds `GLOBAL_HOURLY_USD_CAP`, the breaker
 * trips and rejects new requests until the next hour-bucket rolls
 * over.
 *
 * The breaker is intentionally simple: hour-aligned bucket via INCRBYFLOAT
 * on `global:cost:hour:<epochHour>` plus EXPIRE 7200s. Two-hour expiry
 * gives us readable history at the bucket boundary so the breaker
 * doesn't reset to 0 mid-hour because of clock skew.
 *
 * Tripped events are logged + Sentry-captured at `error` severity so
 * a real incident pages immediately. The tenant whose request
 * triggered the trip sees a 503 with `code = 'global_cost_cap'` —
 * the message is intentionally generic so a single tenant can't
 * probe the cap value.
 */

import type { Redis } from 'ioredis';

export interface GlobalCostBreakerConfig {
  /** Hard cap in USD per hour-bucket. 0 / undefined disables the breaker. */
  hourlyUsdCap: number;
  /** Soft cap fraction (0..1) — log a warning at this level. Default 0.8. */
  warnAtFraction?: number;
  /**
   * Optional override of `Date.now` for tests; bucket boundaries are
   * `Math.floor(now / 3_600_000)`.
   */
  nowFn?: () => number;
}

const BUCKET_TTL_SECONDS = 7200; // 2 × bucket size, see header.
const KEY_PREFIX = 'global:cost:hour:';

export class GlobalCostBreaker {
  private readonly cap: number;
  private readonly warnFrac: number;
  private readonly nowFn: () => number;

  constructor(
    private readonly redis: Redis,
    cfg: GlobalCostBreakerConfig
  ) {
    this.cap = Math.max(0, cfg.hourlyUsdCap);
    this.warnFrac = Math.min(1, Math.max(0, cfg.warnAtFraction ?? 0.8));
    this.nowFn = cfg.nowFn ?? Date.now;
  }

  /** No-op when the breaker is disabled (cap === 0). */
  enabled(): boolean {
    return this.cap > 0;
  }

  private bucketKey(): string {
    return `${KEY_PREFIX}${Math.floor(this.nowFn() / 3_600_000)}`;
  }

  /**
   * Read the current bucket's running total. Returns 0 if the bucket
   * doesn't exist yet (i.e. first request of the hour).
   */
  async currentSpendUsd(): Promise<number> {
    if (!this.enabled()) return 0;
    try {
      const raw = await this.redis.get(this.bucketKey());
      if (!raw) return 0;
      const n = Number.parseFloat(raw);
      return Number.isFinite(n) ? n : 0;
    } catch {
      // Redis hiccup: fail OPEN. The breaker exists to prevent
      // cost-overruns; if Redis is briefly down, we'd rather let
      // requests through than block them. The standalone Redis
      // liveness monitor on the worker / api will surface a real
      // outage independently.
      return 0;
    }
  }

  /**
   * Pre-flight check. Returns `{ ok }` if the request can proceed,
   * `{ blocked, currentUsd, capUsd }` if the breaker is tripped.
   */
  async shouldAllow(): Promise<{ ok: true } | { ok: false; currentUsd: number; capUsd: number }> {
    if (!this.enabled()) return { ok: true };
    const current = await this.currentSpendUsd();
    if (current >= this.cap) {
      return { ok: false, currentUsd: current, capUsd: this.cap };
    }
    return { ok: true };
  }

  /**
   * Post-flight record. Adds `costUsd` to the current bucket. Returns
   * the new running total. Errors are swallowed (cost tracking is
   * best-effort; a Redis hiccup must not break the request path).
   */
  async record(costUsd: number): Promise<number> {
    if (!this.enabled() || !Number.isFinite(costUsd) || costUsd <= 0) return 0;
    try {
      const key = this.bucketKey();
      const next = await this.redis.incrbyfloat(key, costUsd);
      // Set TTL only on first write; subsequent writes don't reset
      // it (we want the bucket to age out at its hour-aligned
      // boundary, not to slide).
      await this.redis.expire(key, BUCKET_TTL_SECONDS, 'NX').catch(() => undefined);
      const total = Number.parseFloat(next);
      return Number.isFinite(total) ? total : 0;
    } catch {
      return 0;
    }
  }

  /** Soft warn threshold — caller can log at `warn` severity. */
  isAtWarnThreshold(currentUsd: number): boolean {
    if (!this.enabled()) return false;
    return currentUsd >= this.cap * this.warnFrac;
  }
}
