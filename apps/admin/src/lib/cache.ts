/**
 * Upstash-backed memoization for admin-side external API calls.
 *
 * The admin app fetches from 8+ external providers on every page view —
 * without caching, each click was paying 300-800ms per provider serially
 * or in parallel. A short-TTL Redis cache sitting in front of each
 * provider call turns a cold navigation (~2s) into a warm navigation
 * (~20ms) for everything already in cache.
 *
 * The key design points:
 * - Failures never pollute the cache: if the fetcher throws, we
 *   propagate the error without writing anything, so the next click
 *   retries immediately.
 * - Cache-layer failures (Redis unreachable, JSON-parse error on a
 *   stale value) never break the caller — we just fall through to the
 *   fetcher as if it were a miss.
 * - Keys are namespaced under `admin:cache:` so they live peacefully
 *   alongside the BullMQ state keys in the shared Upstash instance.
 */
import { redisCmd } from './clients/upstash';

const KEY_PREFIX = 'admin:cache:';

/**
 * Memoize a fetcher behind a Redis-backed cache with a TTL.
 *
 * @param key          Logical cache key (a short slug — we'll prefix it).
 * @param ttlSeconds   Seconds the cached value stays fresh. Use 0 to
 *                     bypass the cache entirely (useful for tests).
 * @param fetcher      The thing to call on a miss. Must throw on error.
 */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>
): Promise<T> {
  if (ttlSeconds <= 0) return fetcher();
  const fullKey = `${KEY_PREFIX}${key}`;

  try {
    const hit = await redisCmd('GET', fullKey);
    if (typeof hit === 'string' && hit.length > 0) {
      return JSON.parse(hit) as T;
    }
  } catch {
    // Cache read / JSON parse failure is non-fatal — fall through to
    // the fetcher as if it were a miss.
  }

  const value = await fetcher();

  try {
    await redisCmd('SET', fullKey, JSON.stringify(value), 'EX', String(ttlSeconds));
  } catch {
    // Cache write failure doesn't affect the caller — the value's
    // already computed; worst case the next click refetches.
  }

  return value;
}

/**
 * Drop a cached value so the next read repopulates from the source.
 * Wire this into actions that mutate remote state (e.g. BullMQ retry
 * / remove) so the UI doesn't keep showing the stale pre-mutation view
 * for the rest of the TTL window.
 */
export async function invalidateCache(key: string): Promise<void> {
  try {
    await redisCmd('DEL', `${KEY_PREFIX}${key}`);
  } catch {
    // Invalidation failure is non-fatal: the TTL will purge it.
  }
}
