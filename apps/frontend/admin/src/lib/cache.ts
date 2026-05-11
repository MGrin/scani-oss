/**
 * Upstash-backed memoization for admin-side external API calls.
 *
 * The admin app fetches from 8+ external providers on every page view —
 * without caching, each click was paying 300-800ms per provider serially
 * or in parallel. A short-TTL Redis cache sitting in front of each
 * provider call turns a cold navigation (~2s) into a warm navigation
 * (~20ms) for everything already in cache.
 *
 * Subrequest batching
 * -------------------
 * Each Cloudflare Worker invocation has a hard subrequest cap (50 on
 * the free tier). The Overview page fans out to ~12 services in
 * parallel; if each one did its own `GET admin:cache:<key>` we'd burn
 * ~12 subrequests just on cache reads, even when everything's a hit.
 *
 * We coalesce concurrent `cached()` reads into a single `MGET` flushed
 * on the next microtask. React Server Components evaluate their async
 * children eagerly in parallel, so every card's `cached()` call lands
 * in the same batch before any of them get to await. The fan-out
 * scaffolding still runs per-card; only the Redis hit collapses.
 *
 * Failures never pollute the cache: if the fetcher throws, we propagate
 * the error without writing anything, so the next click retries
 * immediately. Cache-layer failures (Redis unreachable, JSON-parse
 * error on a stale value) never break the caller — we just fall
 * through to the fetcher as if it were a miss.
 *
 * Keys are namespaced under `admin:cache:` so they live peacefully
 * alongside the BullMQ state keys in the shared Upstash instance.
 */
import { redisCmd } from './clients/upstash';

const KEY_PREFIX = 'admin:cache:';

interface PendingGet {
  key: string;
  resolve: (value: string | null) => void;
}

// Module-level state is request-scoped on the edge runtime: each
// Cloudflare Worker invocation runs in a fresh isolate. So this buffer
// only ever holds keys requested during the current request.
let pendingGets: PendingGet[] = [];
let flushScheduled = false;

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flushBatch);
}

async function flushBatch(): Promise<void> {
  const batch = pendingGets;
  pendingGets = [];
  flushScheduled = false;
  if (batch.length === 0) return;

  // De-dupe identical keys so we don't pay for them twice. Each unique
  // key maps to N waiting promises (rare in practice — happens when two
  // cards share a cache key — but cheap to handle).
  const waitersByKey = new Map<string, PendingGet[]>();
  for (const entry of batch) {
    const list = waitersByKey.get(entry.key);
    if (list) list.push(entry);
    else waitersByKey.set(entry.key, [entry]);
  }
  const uniqueKeys = Array.from(waitersByKey.keys());

  try {
    const prefixed = uniqueKeys.map((k) => `${KEY_PREFIX}${k}`);
    // `MGET` accepts variadic keys and returns an array of values
    // (null for missing keys), one HTTP round-trip total.
    const result =
      prefixed.length === 1
        ? [await redisCmd('GET', prefixed[0]!)]
        : ((await redisCmd('MGET', ...prefixed)) as Array<string | null>);
    const arr = Array.isArray(result) ? result : [];
    uniqueKeys.forEach((key, i) => {
      const raw = arr[i];
      const value = typeof raw === 'string' && raw.length > 0 ? raw : null;
      for (const waiter of waitersByKey.get(key) ?? []) {
        waiter.resolve(value);
      }
    });
  } catch {
    // Any Redis error → resolve every waiter with null (treated as a
    // miss by `cached()`). We must never throw out of the batch; that
    // would propagate to whichever caller happens to be awaiting first
    // and abort cards that have nothing to do with the failure.
    for (const waiter of batch) waiter.resolve(null);
  }
}

function batchedGet(key: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    pendingGets.push({ key, resolve });
    scheduleFlush();
  });
}

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

  const hit = await batchedGet(key);
  if (hit !== null) {
    try {
      return JSON.parse(hit) as T;
    } catch {
      // Stale / malformed value — fall through to the fetcher.
    }
  }

  const value = await fetcher();

  try {
    await redisCmd('SET', `${KEY_PREFIX}${key}`, JSON.stringify(value), 'EX', String(ttlSeconds));
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
