import { createComponentLogger } from '@scani/logging';
import { getSharedRedis, RedisCommandTimeoutError, withRedisTimeout } from '@scani/rate-limiter';
import { Service } from 'typedi';
import type { PortfolioValueResult } from './PortfolioValuationService';

const logger = createComponentLogger('portfolio-value-cache');

// Token prices refresh hourly (the `pricing` cron), so a 45s cross-request
// TTL adds no price staleness. It is the safety net for any mutation path
// that fails to `bust` the key explicitly — worst case the user sees a
// 45s-stale net worth, never longer.
const TTL_SECONDS = 45;

// SCAN page size for `bust`. A user holds only a handful of cached
// variants (per account / base currency), so one page clears them all.
const SCAN_COUNT = 100;

/**
 * How long any one command here may wait for Redis before this cache counts
 * as absent (SC-522).
 *
 * **Without a bound the `catch` blocks below never run.** The shared client is
 * built `{ maxRetriesPerRequest: null }` — BullMQ requires it — and ioredis
 * 5.10.1 only flushes its offline queue `if (typeof maxRetriesPerRequest ===
 * "number")`, so a command issued while the connection is down is never
 * rejected. Measured 2026-08-21 against a real Redis container stopped
 * mid-flight: `getOrCompute` and `bust` each hung for the full 15s and 10s
 * budget they were given, while the api answered `GET /health` 200 in 1.4ms
 * throughout. That is the whole defect — a liveness probe passing over a
 * request path that will never return.
 *
 * **250ms, following the inflow limiter's precedent** (`inflow/redis.ts`):
 * production Redis sits on Fly's 6PN and answers in ~1ms, so this is ~250x the
 * happy path and engages on an outage, never on load.
 *
 * The bound is not Redis-specific and does not leave with Redis: whatever
 * backs this cache, a request path awaiting it with no deadline hangs when it
 * is unreachable. See `withRedisTimeout`.
 *
 * A tight bound is cheaper here than anywhere else in the codebase, because
 * the penalty for a spurious timeout is **exactly a cache miss** — the one
 * outcome this class is built to handle, and one it already takes every time
 * the 45s TTL lapses. There is no correctness surface to trade against.
 */
const REDIS_TIMEOUT_MS = 250;

/**
 * Cross-request cache for whole-portfolio valuations
 * (`PortfolioValueResult`). Without it every `holdings.getWithDetails` /
 * `dashboard.*` request recomputes the full valuation — pricing every
 * token plus Decimal math — and a burst of those saturates the single
 * shared vCPU. Redis-backed so the cache stays consistent across backend
 * machines and survives restarts.
 */
@Service()
export class PortfolioValueCache {
  /**
   * Return the cached valuation for `key`, or run `factory`, cache its
   * result, and return it. A missing, failing or *unresponsive* Redis
   * degrades to a direct `factory()` call — the cache is never required
   * for correctness. The third of those needs `REDIS_TIMEOUT_MS`; without
   * it the read never settles and the degrade never happens.
   */
  async getOrCompute(
    key: string,
    factory: () => Promise<PortfolioValueResult>
  ): Promise<PortfolioValueResult> {
    const redis = getSharedRedis();
    if (!redis) return factory();

    try {
      const cached = await withRedisTimeout(
        redis.get(key),
        REDIS_TIMEOUT_MS,
        () => new RedisCommandTimeoutError('GET', REDIS_TIMEOUT_MS)
      );
      if (cached) return reviveDates(JSON.parse(cached) as PortfolioValueResult);
    } catch (error) {
      logger.warn({ error, key }, 'Portfolio-value cache read failed — recomputing');
    }

    const value = await factory();

    // Fire-and-forget write: a slow Redis must add zero latency to the
    // response. The key already encodes user + account + base currency.
    redis
      .set(key, JSON.stringify(value), 'EX', TTL_SECONDS)
      .catch((error) => logger.warn({ error, key }, 'Portfolio-value cache write failed'));

    return value;
  }

  /**
   * Drop every cached valuation for a user (all account / base-currency
   * variants). Call from any path that changes what counts toward the
   * user's net worth. Errors are swallowed — the TTL is the backstop.
   *
   * Bounded for the same reason as the read, and it matters more here:
   * this runs inside `enqueuePortfolioRollup`, on the api's mutation
   * request path, where an unbounded SCAN hangs the user's write rather
   * than their read.
   */
  async bust(userId: string): Promise<void> {
    const redis = getSharedRedis();
    if (!redis) return;

    try {
      let cursor = '0';
      do {
        const [next, keys] = await withRedisTimeout(
          redis.scan(cursor, 'MATCH', `pv:v1:${userId}:*`, 'COUNT', SCAN_COUNT),
          REDIS_TIMEOUT_MS,
          () => new RedisCommandTimeoutError('SCAN', REDIS_TIMEOUT_MS)
        );
        cursor = next;
        if (keys.length > 0) {
          await withRedisTimeout(
            redis.unlink(...keys),
            REDIS_TIMEOUT_MS,
            () => new RedisCommandTimeoutError('UNLINK', REDIS_TIMEOUT_MS)
          );
        }
      } while (cursor !== '0');
    } catch (error) {
      logger.warn({ error, userId }, 'Portfolio-value cache bust failed');
    }
  }
}

// `PortfolioValueResult.holdings[].priceTimestamp` is a `Date`; JSON
// round-trips it as an ISO string. Revive it so downstream serialization
// (tRPC / superjson) still emits a real Date, not a string.
function reviveDates(result: PortfolioValueResult): PortfolioValueResult {
  for (const holding of result.holdings) {
    if (holding.priceTimestamp !== undefined) {
      holding.priceTimestamp = new Date(holding.priceTimestamp);
    }
  }
  return result;
}
