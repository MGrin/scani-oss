# @scani/rate-limiter

Resilience primitives for upstream calls. Three concerns, each protecting
the same boundary in a different way:

- **Rate limiting** — keep call rate under an upstream budget.
- **Circuit breakers** — stop calling an upstream that's clearly broken.
- **Retry** — wrap individual calls when the failure looks transient.

Each is modeled as either an abstract base + persistence-specific
subclasses (where state needs sharing across replicas) or a stateless
helper (where it doesn't). Pick what matches your deployment topology.

## Three concerns

### Outflow — "we make N calls per minute to upstream X"

Used to stay inside a per-API-key budget upstream providers enforce
(CoinGecko 25/min on free tier, Etherscan 5/sec, IBKR Flex 1018, …).
Wrap each upstream call in `execute(fn)`; the limiter blocks until a
slot opens within the rolling `windowMs`.

| Class | Backend | When to use |
|---|---|---|
| `OutflowRateLimiter` (abstract) | — | Subclass it if neither in-memory nor Redis fits. |
| `InMemoryOutflowRateLimiter` | per-process Map | Tests, truly single-process deployments. |
| `RedisOutflowRateLimiter` | Redis sorted-set + Lua sliding window | Multi-worker deployments — one budget shared across replicas, otherwise N workers × Mrps × N exceeds the upstream cap. |

### Inflow — "this HTTP endpoint accepts N requests per minute per client"

Used at the api's HTTP boundary to admit/reject requests up-front
(returns `{ ok: false, retryAfterSec }` so the caller can emit a
proper `429 Too Many Requests` with `Retry-After`). Fixed-window
counter — INCR + EXPIRE on Redis, atomic and trivially coherent across
replicas. Worst case is 2× the limit at a window boundary, which is
fine for HTTP admission.

| Class | Backend | When to use |
|---|---|---|
| `InflowRateLimiter` (abstract) | — | Subclass for non-Redis, non-in-memory backends (rare). |
| `InMemoryInflowRateLimiter` | per-process Map with TTL eviction | Tests, single-instance dev. |
| `RedisInflowRateLimiter` | Redis `INCRBY` / `EXPIRE` | Production api (multi-instance). |

### Circuit breaker — "stop calling X for a while because it's failing"

Tracks consecutive failures per provider key. After
`failureThreshold` failures the circuit opens and subsequent calls
short-circuit until `cooldownMs` elapses, after which a single probe
call is admitted. In-process only (per-replica state diverges, but the
multi-minute cooldown amortises that).

| Export | Purpose |
|---|---|
| `CircuitBreaker` | The class. Construct your own with custom `failureThreshold` / `cooldownMs`. |
| `pricingCircuitBreaker` | Pre-built singleton: `5 fails / 5 min`. Used by `PricingService` per provider. |
| `integrationCircuitBreaker` | Pre-built singleton: `5 fails / 2 min`. Used by `SyncWalletBalancesUseCase` per institution. |

### Retry — "the call failed transiently; try again with backoff"

```ts
import { withRetry } from '@scani/rate-limiter';

const result = await withRetry(() => provider.fetchBalances(ctx), {
  attempts: 3,
  baseDelayMs: 1000,
  isTransient: defaultIsTransient,
});
```

`defaultIsTransient` classifies network errors and HTTP 429 / 5xx as
retryable; everything else (validation failures, auth errors) bubbles
out on the first attempt.

## Factories

These pick the right impl based on whether a Redis client is provided.
Tests and OSS self-host paths get in-memory automatically.

```ts
import { createOutflowLimiter } from '@scani/rate-limiter';

const limiter = createOutflowLimiter({
  redis: redisClientOrNull,
  namespace: 'coingecko',         // required when redis is set
  maxRequests: 25,
  windowMs: 60_000,
});

await limiter.execute(() => fetch('https://api.coingecko.com/...'));
```

```ts
import { createStandardLimiter, createStrictLimiter } from '@scani/rate-limiter';

// Pre-configured inflow limiters — names match the historical api callers.
const globalLimiter = createStandardLimiter(redis, 300); // 300/min default
const strictLimiter = createStrictLimiter(redis, 60);    // 60/min default

const out = await strictLimiter.tryConsume(req);
if (!out.ok) {
  set.headers['Retry-After'] = String(out.retryAfterSec);
  return new Response('rate limited', { status: 429 });
}
```

## Sub-key partitioning (outflow)

Both `OutflowRateLimiter` subclasses accept an optional `subKey` second
arg to `execute(fn, subKey)`. Different subKeys get independent
sliding windows. Use this for per-credential limits so one user's
Binance/IBKR/etc. traffic doesn't starve another's, and so
provider-side per-token limits stay accurate.

The convention: hash the credential with `credentialBucketKey(raw)`
before passing it as a subKey — raw API keys must never become Redis
keys.

```ts
import { createOutflowLimiter, credentialBucketKey } from '@scani/rate-limiter';

const limiter = createOutflowLimiter({ redis, namespace: 'binance', maxRequests: 1200, windowMs: 60_000 });

await limiter.execute(
  () => binance.spot.account(),
  credentialBucketKey(userApiKey),
);
```

## Shared-Redis convention

Some module-level limiter declarations (e.g. `PricingService`'s
`GLOBAL_RATE_LIMITERS`) need a Redis handle but can't easily take it
through DI because the limiters are constructed at module load. The
package exposes a process-wide `setSharedRedis(redis)` /
`getSharedRedis()` for this case.

```ts
// at app boot
import { setSharedRedis } from '@scani/rate-limiter';
setSharedRedis(redisConnection);

// at module load (PricingService)
import { createOutflowLimiter, getSharedRedis } from '@scani/rate-limiter';
const limiter = createOutflowLimiter({
  redis: getSharedRedis(),
  namespace: 'finnhub',
  maxRequests: 50,
  windowMs: 60_000,
});
```

If `setSharedRedis` is never called, `getSharedRedis` returns `null`
and the factory falls back to the in-memory impl — which is the
correct behaviour for tests.

## Inflow keying

`defaultInflowKey(req)` extracts the client identity from edge-proxy
headers, in priority order: `cf-connecting-ip` → `fly-client-ip` →
`x-real-ip` → rightmost entry of `x-forwarded-for` → `UA|Origin|Method`.

The `x-forwarded-for` *rightmost* matters: Fly and Cloudflare APPEND
the real client IP at the tail, so the leftmost values are
attacker-controlled. Keying on the whole list would let a caller
rotate a random prefix and trivially bypass the counter.

Override via `key: (req) => string` in `InflowRateLimiterOptions` for
endpoints that should partition differently (e.g. by user id).
