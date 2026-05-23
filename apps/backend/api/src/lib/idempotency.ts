/**
 * In-memory idempotency cache for tRPC mutations.
 *
 * When a client retries a mutation (e.g., network blip between submission
 * and response), we do NOT want to create a second account/holding/etc.
 * If the client supplies an idempotency key and we've already processed a
 * request with the same (userId, key) pair within the TTL, return the
 * previously computed response instead of running the mutation again.
 *
 * The cache is intentionally in-memory: simple, zero ops, and sufficient
 * for the common "user double-clicked submit" case. It does NOT survive
 * process restarts, and it does NOT coordinate between backend instances.
 * That's an accepted trade-off — the alternative (a PG-backed cache) adds
 * migrations and ops overhead for a marginal protection window.
 *
 * Usage:
 *   return withIdempotency(ctx.userId, input.idempotencyKey, async () => {
 *     return await doTheMutation(input);
 *   });
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 10_000; // safety cap to bound memory

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
// Track in-flight promises so concurrent requests with the same key wait on
// the same underlying work instead of racing.
const inFlight = new Map<string, Promise<unknown>>();

function makeKey(userId: string | null | undefined, key: string): string {
  return `${userId ?? 'anon'}::${key}`;
}

function evictIfFull() {
  if (cache.size <= MAX_ENTRIES) return;
  // Simple strategy: drop the oldest 10% by expiry.
  const toDrop = Math.ceil(MAX_ENTRIES * 0.1);
  let dropped = 0;
  for (const k of cache.keys()) {
    if (dropped >= toDrop) break;
    cache.delete(k);
    dropped++;
  }
}

export async function withIdempotency<T>(
  userId: string | null | undefined,
  idempotencyKey: string | undefined,
  fn: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<T> {
  // No key supplied → fall through to direct execution. This lets routers
  // accept an *optional* key without changing control flow for clients that
  // don't send one.
  if (!idempotencyKey) {
    return fn();
  }

  const key = makeKey(userId, idempotencyKey);
  const now = Date.now();

  // Return cached result if still fresh.
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value as T;
  }
  if (cached) {
    // Expired — drop it before running again.
    cache.delete(key);
  }

  // De-duplicate concurrent in-flight requests.
  const existing = inFlight.get(key);
  if (existing) {
    return existing as Promise<T>;
  }

  const p = (async () => {
    try {
      const value = await fn();
      cache.set(key, { value, expiresAt: Date.now() + ttlMs });
      evictIfFull();
      return value;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, p);
  return p;
}

/** Test-only: clear the cache. Not exported from package barrels. */
export function _resetIdempotencyCache(): void {
  cache.clear();
  inFlight.clear();
}
