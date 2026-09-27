import { StoreCommandTimeoutError, withDeadline } from '@scani/deadline';
import { createComponentLogger } from '@scani/logging';
import { getSharedRedis } from '@scani/rate-limiter';
import { Service } from 'typedi';
import type { PortfolioValueResult } from './PortfolioValuationService';

const logger = createComponentLogger('portfolio-value-cache');

// The key carries `PortfolioValueVersion`, so a changed holding or a new price
// for a held token is a different key and never a stale hit. The TTL bounds
// only what that fingerprint cannot see — a price quoted against a base that
// is neither the user's nor a hub. It was 45s while the key carried no
// version, and that lapsed between most Home loads, recomputing 1.1–1.7s of
// synchronous work on the api's one thread each time (SC-1322).
const TTL_SECONDS = 60 * 60;

// SCAN page size for `bust`. A user holds only a handful of cached
// variants (per account / base currency), so one page clears them all.
const SCAN_COUNT = 100;

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
  private readonly inFlight = new Map<string, Promise<PortfolioValueResult>>();

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
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const pending = this.compute(key, factory, () => this.inFlight.get(key) === pending);
    this.inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    }
  }

  private async compute(
    key: string,
    factory: () => Promise<PortfolioValueResult>,
    isCurrent: () => boolean
  ): Promise<PortfolioValueResult> {
    const redis = getSharedRedis();
    if (!redis) return factory();

    try {
      const cached = await withDeadline(
        redis.get(key),
        REDIS_TIMEOUT_MS,
        () => new StoreCommandTimeoutError('redis', 'GET', REDIS_TIMEOUT_MS)
      );
      if (cached) return reviveDates(JSON.parse(cached) as PortfolioValueResult);
    } catch (error) {
      logger.warn({ error, key }, 'Portfolio-value cache read failed — recomputing');
    }

    const value = await factory();

    // Fire-and-forget write: a slow Redis must add zero latency to the
    // response. The key already encodes user + account + base currency.
    if (isCurrent())
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
    for (const key of this.inFlight.keys()) {
      if (key.startsWith(`pv:v2:${userId}:`)) this.inFlight.delete(key);
    }
    const redis = getSharedRedis();
    if (!redis) return;

    try {
      let cursor = '0';
      do {
        const [next, keys] = await withDeadline(
          redis.scan(cursor, 'MATCH', `pv:v2:${userId}:*`, 'COUNT', SCAN_COUNT),
          REDIS_TIMEOUT_MS,
          () => new StoreCommandTimeoutError('redis', 'SCAN', REDIS_TIMEOUT_MS)
        );
        cursor = next;
        if (keys.length > 0) {
          await withDeadline(
            redis.unlink(...keys),
            REDIS_TIMEOUT_MS,
            () => new StoreCommandTimeoutError('redis', 'UNLINK', REDIS_TIMEOUT_MS)
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
