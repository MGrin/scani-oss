/**
 * Tiny in-memory LRU cache with per-entry TTL. Keeps the cache bounded
 * by `maxEntries` (least-recently-used eviction) and lazily prunes
 * expired entries on read.
 *
 * Why not pull in `lru-cache` from npm? The behaviour we need fits in
 * 60 lines, the LRU semantics rely on a property of `Map` we already
 * use throughout the codebase (insertion order ≡ recency-of-set), and
 * the alternative is another transitive dep + a barrel that's already
 * heavy. Keep it inline.
 *
 * Usage:
 *   const cache = new LruCache<string, MyResult>({ maxEntries: 100, ttlMs: 5 * 60_000 });
 *   const cached = cache.get('key');
 *   if (cached) return cached;
 *   const fresh = await compute();
 *   cache.set('key', fresh);
 *
 * Not thread-safe. Bun is single-threaded for this code path so that
 * doesn't matter; if a future caller is async-multi-process, they
 * should use Redis.
 */
export interface LruCacheOptions {
  maxEntries: number;
  ttlMs: number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class LruCache<K, V> {
  private readonly entries = new Map<K, Entry<V>>();

  constructor(private readonly opts: LruCacheOptions) {}

  /**
   * Read a key. Returns `undefined` if missing or expired. Re-inserts
   * on hit so the entry moves to the back of the eviction order
   * (LRU semantics: most-recently-used = most-recently-set).
   */
  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Bump recency.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    // Delete-then-set so an existing entry is moved to the end
    // (most-recently-used position).
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + this.opts.ttlMs });
    // Evict oldest while over cap. Map keys() returns insertion order,
    // so the first key is the least-recently-used.
    while (this.entries.size > this.opts.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Remove a single key. Returns true if it was present. */
  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  /** Wipe everything. Useful for tests + on auth-state changes. */
  clear(): void {
    this.entries.clear();
  }

  /** Size of the cache (does not prune expired entries first). */
  get size(): number {
    return this.entries.size;
  }
}
