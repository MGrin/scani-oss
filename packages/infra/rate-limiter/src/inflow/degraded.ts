/**
 * The one thing a Redis-backed inflow limiter does that nothing else can see.
 *
 * `RedisInflowRateLimiter` deliberately degrades to in-process counting when
 * Redis does not answer (SC-225) — the alternative is holding every request,
 * including `/health`, on a dependency they never asked for. But the catch that
 * does it is silent, and the effect is not: the shared bucket is what makes N
 * replicas honour one limit, so every fallback multiplies the configured cap by
 * however many processes are counting, and restarts that process's count at
 * zero.
 *
 * `observeRedisReachability` already reports a Redis that has gone *away* —
 * it listens on connection events, so a disconnect is logged and a long one is
 * escalated. It cannot see the case this handler is for: a connected Redis that
 * answered too slowly, under load, on a box with nothing else wrong. That one
 * leaves no trace anywhere today, which is how a rate-limit assertion can fail
 * with `Expected 429, Received 404` and no explanation to be found (SC-489).
 *
 * A process-wide handler rather than a per-limiter option, matching
 * `setSharedRedis` beside it: an app has one logger and five limiters, and
 * threading it through five factory signatures buys nothing.
 */
export interface InflowDegradedReport {
  /** Storage namespace of the limiter that fell back, e.g. `rl:standard`. */
  namespace: string;
  /** How long it waited before giving up on Redis. */
  timeoutMs: number;
  /** The timeout or rejection that triggered the fallback. */
  error: unknown;
  /**
   * Fallbacks this limiter served since it last reported, this one included.
   * An outage degrades every request, so reports are throttled — without this
   * count the log would say "it happened" and never "how much".
   */
  count: number;
}

export type InflowDegradedHandler = (report: InflowDegradedReport) => void;

let handler: InflowDegradedHandler | null = null;

/** Install the process's handler. Pass `null` to remove it (tests). */
export function setInflowDegradedHandler(next: InflowDegradedHandler | null): void {
  handler = next;
}

/**
 * Report a fallback. Never throws: a handler that fails must not turn a
 * degraded limiter into a failed request, which is the whole point of the
 * degraded path.
 */
export function reportInflowDegraded(report: InflowDegradedReport): void {
  if (!handler) return;
  try {
    handler(report);
  } catch {
    // Deliberately swallowed — see above.
  }
}
