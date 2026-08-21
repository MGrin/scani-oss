/**
 * A bound on a single Redis command (SC-225 / SC-254 / SC-294 / SC-522).
 *
 * ## Why this lives in a package of its own (SC-523)
 *
 * It was written inside `@scani/rate-limiter`, because that is where the
 * first three call sites were. `@scani/queue` then needed the same bound on
 * `queue.add`, and the obvious move — `queue` depends on `rate-limiter` — is
 * backwards: enqueue does not need rate limiting, it needs a deadline on an
 * unreachable dependency. **A second consumer wanting this is the signal that
 * it was in the wrong place**, not that the first package should be depended
 * upon. So it moved somewhere neutral, with no dependencies of its own, and
 * both packages import it from here.
 *
 * The exported names still say *Redis* while the package says *deadline*, and
 * that is deliberate: the symbols describe the transport these call sites use
 * today, the package describes the guarantee. The rename belongs with the
 * migration that changes the transport (see below), not with the move.
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
 * ## This is about an unreachable DEPENDENCY, not about Redis
 *
 * The `maxRetriesPerRequest` detail above explains why the hang is *silent*
 * here; it is not why the bound is needed. A request path that awaits a remote
 * store with no deadline hangs whenever that store is unreachable, and every
 * store can be unreachable — Postgres holds a query behind a saturated pool or
 * a failed-over primary exactly as readily as ioredis holds a command behind a
 * dead socket. The defect this exists to stop is "a health check answers 200
 * over a request that will never return", and nothing in that sentence names a
 * product.
 *
 * So: **if the store behind these call sites is ever replaced, the bound stays
 * and gets renamed — it does not get deleted with the client.** Written down
 * because a migration in flight (SC-518, moving the limiters to Postgres)
 * touches these exact files, and a reader who takes this for Redis-specific
 * scaffolding would remove the only thing keeping the failure loud.
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
