// Sliding-window rate limiter for *outbound* calls — i.e. requests this
// process makes to upstream APIs (CoinGecko, Etherscan, Binance, …).
// Callers wrap each upstream call in `execute(fn)`; the limiter blocks
// until a slot opens within the rolling `windowMs`.
//
// The abstract base owns the orchestration loop. Subclasses implement
// `tryAcquire`, which is the only piece that varies between in-memory
// and Redis backends.

const ACQUIRE_JITTER_MAX_MS = 25;

export abstract class OutflowRateLimiter {
  protected readonly maxRequests: number;
  protected readonly windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  // `subKey` partitions the bucket — different subKeys get independent
  // sliding windows. Used for per-credential limits (hashed API key) so
  // one user's traffic doesn't starve another's, and so provider-side
  // per-token limits stay accurate.
  async execute<T>(fn: () => Promise<T>, subKey?: string, signal?: AbortSignal): Promise<T> {
    await this.waitForSlot(subKey, signal);
    signal?.throwIfAborted();
    return fn();
  }

  // Single-shot fail-fast variant. Used by inbound HTTP handlers that
  // need to reject (429) instead of wait. Returns `{ ok: true }` if a
  // slot was acquired, or `{ ok: false, retryAfterMs }` otherwise.
  async tryConsume(subKey?: string): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
    const waitMs = await this.tryAcquire(subKey);
    if (waitMs === 0) return { ok: true };
    return { ok: false, retryAfterMs: waitMs };
  }

  protected async waitForSlot(subKey?: string, signal?: AbortSignal): Promise<void> {
    while (true) {
      signal?.throwIfAborted();
      const waitMs = await this.tryAcquire(subKey);
      signal?.throwIfAborted();
      if (waitMs === 0) return;
      // Add a tiny jitter so colliding callers don't all wake up at the
      // exact same millisecond and re-race.
      await sleep(waitMs + Math.floor(Math.random() * ACQUIRE_JITTER_MAX_MS), signal);
    }
  }

  /**
   * Returns 0 if a slot was acquired, otherwise the milliseconds the
   * caller should wait before retrying.
   */
  protected abstract tryAcquire(subKey?: string): Promise<number>;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
