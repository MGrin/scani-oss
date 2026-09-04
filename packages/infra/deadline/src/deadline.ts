/**
 * A bound on a single await of a remote store (SC-225 / SC-254 / SC-294 /
 * SC-522 / SC-523 / SC-578).
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
 * ## The symbols used to say *Redis*, and no longer do (SC-578)
 *
 * They did because every call site spoke to Redis, and the previous version of
 * this comment said the rename belonged with the migration that changed the
 * transport rather than with the move. SC-518 was that migration: it put
 * BullMQ on the Postgres backend, and `bullmq-enqueue-service.ts` went on
 * raising `redis enqueue timed out` for a `pg` query. An operator who met that
 * during an incident went and looked at a Redis that was perfectly healthy.
 *
 * So `withDeadline` and `StoreCommandTimeoutError` are transport-neutral now,
 * and the store each call site actually talks to is named at the call site.
 * The enqueue is the only one that names Postgres; every other site is still
 * genuinely Redis, passes `'redis'`, and its message is unchanged.
 *
 * ## Why every await on a remote store needs one
 *
 * The defect this exists to stop is "a health check answers 200 over a request
 * that will never return", and nothing in that sentence names a product. Every
 * store can be unreachable, and each one has its own way of never answering:
 *
 * **ioredis** — the api, worker and data-provider all build their shared
 * client with `maxRetriesPerRequest: null`. That was BullMQ's requirement; it
 * no longer uses these clients (SC-518 moved the queue to Postgres) and the
 * option is still set, so what follows is why that matters whatever the
 * original reason was. In ioredis 5.10.1 the queue-flush branch runs only
 * `if (typeof maxRetriesPerRequest === "number")`
 * (`built/redis/event_handler.js:199`), so
 * a command issued while the connection is down is never rejected — it sits in
 * the offline queue until the connection returns, which on a machine whose
 * Redis host stopped resolving is never. Measured against a real client on a
 * dead port: still pending after 4000ms, where `maxRetriesPerRequest: 1`
 * rejects with `MaxRetriesPerRequestError`.
 *
 * **node-postgres** — three waits, none of them bounded by default, measured
 * 2026-08-22 against `pg-pool` 3.14.0 and BullMQ 6.2.0's Postgres backend:
 * `connectionTimeoutMillis` is unset, so a caller waiting for one of the
 * pool's ten slots is pushed onto `_pendingQueue` with no timer at all
 * (`pg-pool/index.js:206`); no `statement_timeout` is set on that pool, so a
 * statement blocked on a lock waits for the lock; and a socket to a host that
 * black-holes rather than refuses waits on the OS. Measured: `queue.add` with
 * `bullmq.job` held under `ACCESS EXCLUSIVE` was still unsettled at 30s and
 * resolved at 30684ms — when the lock was released, not on any deadline of its
 * own.
 *
 * The consequence is the same for both, and it is why the bound cannot go on
 * the client: `try { await store.get(k) } catch { degrade }` is not a degraded
 * path there. It is a hang wearing one, because the catch cannot run until
 * something rejects.
 *
 * **If the store behind a call site is ever replaced again, the bound stays,
 * gets renamed, and gets RE-SIZED** — it does not get deleted with the client,
 * and it does not keep a number that was argued from the old transport's
 * behaviour. SC-518 kept the bound, correctly, and carried a 2000ms constant
 * sized against ioredis's retry cadence onto a `pg` query where that reasoning
 * means nothing; SC-578 is the second half of the same job.
 *
 * ## The timed-out command is NOT cancelled
 *
 * Neither client offers that. ioredis has no such API and leaves the command
 * in its offline queue, to land whenever the connection returns; `pg` has no
 * cancel on a `pool.query`, so the statement keeps running on the server and
 * commits when it stops being blocked (measured above: the timed-out enqueue's
 * row was written at 30684ms, long after any caller had given up). That is
 * deliberate everywhere this is used — the caller stops waiting, the eventual
 * write still happens — but it is the reason a bound sized too tight costs
 * more than a wasted retry. See `ENQUEUE_TIMEOUT_MS`.
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
export async function withDeadline<T>(
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
 * A command against a remote store that did not answer inside its bound.
 *
 * Named distinctly from a connection error on purpose: "timed out after 250ms"
 * and "connect ECONNREFUSED" describe different things to whoever reads the
 * log, and reporting them identically is what made a stranded connection look
 * like a deploy in progress (SC-225).
 *
 * `store` is required rather than defaulted, because the message is read
 * during an incident and it is the word that decides which dependency somebody
 * goes and looks at. A default would let a call site inherit the wrong one
 * silently, which is exactly what SC-578 was (SC-518 moved the queue to
 * Postgres and its enqueue kept saying `redis`).
 */
export class StoreCommandTimeoutError extends Error {
  constructor(
    readonly store: string,
    readonly operation: string,
    readonly timeoutMs: number
  ) {
    super(`${store} ${operation} timed out after ${timeoutMs}ms`);
    this.name = 'StoreCommandTimeoutError';
  }
}
