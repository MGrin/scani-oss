# @scani/deadline

A bound on a single `await` of a remote dependency, and the error it rejects
with. One function, one error class, **no dependencies** — which is the point:
any package may take this without inheriting anything else.

| Export | Purpose |
|---|---|
| `withRedisTimeout(work, timeoutMs, makeError)` | Race `work` against `timeoutMs`; reject with `makeError()` if the bound wins. Clears the timer, `unref`s it, and swallows the loser's late rejection. |
| `RedisCommandTimeoutError` | `redis <operation> timed out after <n>ms`. Named distinctly from a connection error on purpose — the two describe different things to whoever reads the log. |

## Why it exists

The api, worker and data-provider all build their shared ioredis client with
`maxRetriesPerRequest: null`, because BullMQ requires it. ioredis only flushes
its offline queue `if (typeof maxRetriesPerRequest === "number")`, so a command
issued while the connection is down is **never rejected** — it waits for a
connection that, on a machine whose Redis host stopped resolving, never comes.

The consequence is that `try { await redis.get(k) } catch { degrade }` is not a
degraded path. It is a hang wearing one. Every await on that connection needs a
bound *before* it has any error handling at all.

## Why it is a package rather than a file in `@scani/rate-limiter`

It was a file there, because that is where the first three call sites were.
`@scani/queue` then needed the same bound on `queue.add` (SC-523), and
`queue → rate-limiter` is a backwards dependency: enqueue does not need rate
limiting. A second consumer wanting a helper is the signal that the helper is
in the wrong place.

## The names say Redis; the package says deadline

Deliberate. The guarantee is not about Redis — a request path awaiting *any*
remote store with no deadline hangs when that store is unreachable, and
Postgres holds a query behind a saturated pool exactly as readily as ioredis
holds a command behind a dead socket. So **if the store behind these call sites
is replaced, this code is renamed, not deleted** (SC-518 moves the limiters to
Postgres and touches these exact files). Renaming the symbols is that
migration's job; it did not belong to the move.

## The timed-out command is not cancelled

ioredis has no such API. The command stays in the offline queue and lands
whenever the connection returns. That is intended everywhere this is used — the
caller stops waiting, the eventual write still happens. Callers that report a
failure to a user must account for the work possibly happening anyway.
