import { createComponentLogger } from '@scani/logging';
import { getSharedRedis } from '@scani/rate-limiter';
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
   * result, and return it. A missing or failing Redis degrades to a
   * direct `factory()` call — the cache is never required for
   * correctness.
   */
  async getOrCompute(
    key: string,
    factory: () => Promise<PortfolioValueResult>
  ): Promise<PortfolioValueResult> {
    const redis = getSharedRedis();
    if (!redis) return factory();

    try {
      const cached = await redis.get(key);
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
   */
  async bust(userId: string): Promise<void> {
    const redis = getSharedRedis();
    if (!redis) return;

    try {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(
          cursor,
          'MATCH',
          `pv:v1:${userId}:*`,
          'COUNT',
          SCAN_COUNT
        );
        cursor = next;
        if (keys.length > 0) await redis.unlink(...keys);
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
