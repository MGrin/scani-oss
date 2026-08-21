/**
 * A bound on a single Redis command (SC-225 / SC-254 / SC-294 / SC-522).
 *
 * ## Why every await on the shared connection needs one
 *
 * The api, worker and data-provider all build their shared client with
 * `maxRetriesPerRequest: null`, because BullMQ asserts that option must be
 * null. In ioredis 5.10.1 the queue-flush branch runs only `if (typeof
 * maxRetriesPerRequest === "number")` (`built/redis/event_handler.js:199`), so
 * a command issued while the connection is down is never rejected — it sits in
 * the offline queue until the connection returns, which on a machine whose
 * Redis host stopped resolving is never. Measured against a real client on a
 * dead port: still pending after 4000ms, where `maxRetriesPerRequest: 1`
 * rejects with `MaxRetriesPerRequestError`.
 *
 * The consequence is that `try { await redis.get(k) } catch { degrade }` is
 * not a degraded path. It is a hang wearing one: the catch cannot run because
 * nothing rejects. Every such site needs a bound before it has any error
 * handling at all, and the bound cannot go on the client.
 *
 * ## The timed-out command is NOT cancelled
 *
 * ioredis has no such API. It stays in the offline queue and lands whenever
 * the connection returns. That is deliberate everywhere this is used — the
 * caller stops waiting, the eventual write still happens.
 */

/**
 * Race `work` against `timeoutMs`, rejecting with `makeError()` if the bound
 * wins.
 *
 * Three details, each of which was a bug somewhere before it was a rule:
 *
 *  - The timer is cleared in `finally`, so the happy path does not leave a
 *    pending timeout behind. Callers run this in a loop (`waitForSlot`) or per
 *    request, so a leaked timer per call accumulates.
 *  - The timer is `unref`'d: a bound that is still counting must not hold the
 *    process open at shutdown.
 *  - `work` gets a no-op catch. When the bound wins, `work` is still live and
 *    may reject minutes later; without a handler that surfaces as an unhandled
 *    rejection attributed to nothing, which is its own debugging problem.
 */
export async function withRedisTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  makeError: () => Error
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  work.catch(() => undefined);

  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(makeError()), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A Redis command that did not answer inside its bound.
 *
 * Named distinctly from a connection error on purpose: "timed out after 250ms"
 * and "connect ECONNREFUSED" describe different things to whoever reads the
 * log, and reporting them identically is what made a stranded connection look
 * like a deploy in progress (SC-225).
 */
export class RedisCommandTimeoutError extends Error {
  constructor(
    readonly operation: string,
    readonly timeoutMs: number
  ) {
    super(`redis ${operation} timed out after ${timeoutMs}ms`);
    this.name = 'RedisCommandTimeoutError';
  }
}
