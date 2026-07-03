/**
 * In-memory memoization for admin-side external API calls.
 *
 * The admin app fetches from 8+ external providers on every page view —
 * without caching, each click pays 300-800ms per provider. A short-TTL
 * cache in front of each provider call keeps warm navigations fast.
 *
 * This used to be Upstash-Redis-backed; when the Upstash database was
 * retired (2026-07 cost reduction) it became a module-scope Map. On the
 * Cloudflare edge runtime that means the cache lives per isolate:
 * requests that land on a warm isolate get hits, a cold isolate
 * refetches everything. For a single-operator dashboard that trade-off
 * is fine — worst case a click is as slow as the pre-cache era — and it
 * costs zero infrastructure.
 *
 * Failures never pollute the cache: if the fetcher throws, nothing is
 * written, so the next click retries immediately.
 */

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const store = new Map<string, CacheEntry>();

// Keep the map bounded even if keys churn (e.g. per-job detail keys).
// Sweep opportunistically on writes; hard-cap by evicting oldest.
const MAX_ENTRIES = 500;

function sweep(now: number): void {
  for (const [k, entry] of store) {
    if (entry.expiresAt <= now) store.delete(k);
  }
  if (store.size > MAX_ENTRIES) {
    const excess = store.size - MAX_ENTRIES;
    let i = 0;
    for (const k of store.keys()) {
      if (i++ >= excess) break;
      store.delete(k);
    }
  }
}

/**
 * Memoize a fetcher behind an in-memory cache with a TTL.
 *
 * @param key          Logical cache key (a short slug).
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

  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) return hit.value as T;

  const value = await fetcher();
  store.set(key, { value, expiresAt: now + ttlSeconds * 1000 });
  sweep(now);
  return value;
}

/**
 * Drop a cached value so the next read repopulates from the source.
 * Wire this into actions that mutate remote state (e.g. BullMQ retry
 * / remove) so the UI doesn't keep showing the stale pre-mutation view
 * for the rest of the TTL window. Per-isolate only — another isolate's
 * copy expires via its TTL.
 */
export async function invalidateCache(key: string): Promise<void> {
  store.delete(key);
}
