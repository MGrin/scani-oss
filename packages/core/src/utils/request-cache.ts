import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Request-scoped cache using AsyncLocalStorage
 * This allows caching expensive computations within a single HTTP request
 * without leaking data between requests.
 *
 * IMPORTANT: For tRPC batched requests, use the context-based cache helpers
 * (getOrComputeFromCache, etc.) with the requestCache from ctx.
 * The AsyncLocalStorage approach doesn't work for tRPC batches because each
 * procedure runs in a separate async context.
 *
 * Usage:
 * 1. For tRPC: Pass ctx.requestCache to the caching functions
 * 2. For non-tRPC: Use runWithRequestCache() wrapper
 */

interface RequestCacheStore {
  cache: Map<string, unknown>;
}

const requestCacheStorage = new AsyncLocalStorage<RequestCacheStore>();

// Special prefix for in-flight promises to deduplicate concurrent requests
const PENDING_PREFIX = "__pending__";

// ============================================================================
// Context-based cache helpers (for tRPC batched requests)
// These work by passing the cache Map directly, avoiding AsyncLocalStorage issues
// ============================================================================

/**
 * Get or compute a value from a context-provided cache
 * Use this in tRPC procedures with ctx.requestCache
 *
 * IMPORTANT: This handles concurrent requests for the same key by storing
 * the pending promise in the cache. If multiple calls happen simultaneously,
 * they will all await the same promise instead of computing multiple times.
 */
export async function getOrComputeFromCache<T>(
  cache: Map<string, unknown> | undefined,
  key: string,
  factory: () => Promise<T>,
): Promise<T> {
  if (!cache) {
    // No cache provided, just compute
    return factory();
  }

  // Check if we have a cached result
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached as T;
  }

  // Check if there's already a pending computation for this key
  const pendingKey = PENDING_PREFIX + key;
  const pending = cache.get(pendingKey) as Promise<T> | undefined;
  if (pending) {
    // Another call is already computing this, wait for it
    return pending;
  }

  // Start the computation and store the promise
  const promise = factory();
  cache.set(pendingKey, promise);

  try {
    const value = await promise;
    // Store the final result
    cache.set(key, value);
    // Clean up the pending promise
    cache.delete(pendingKey);
    return value;
  } catch (error) {
    // Clean up the pending promise on error
    cache.delete(pendingKey);
    throw error;
  }
}

/**
 * Synchronous version of getOrComputeFromCache
 */
export function getOrComputeFromCacheSync<T>(
  cache: Map<string, unknown> | undefined,
  key: string,
  factory: () => T,
): T {
  if (!cache) {
    return factory();
  }

  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached as T;
  }

  const value = factory();
  cache.set(key, value);
  return value;
}

/**
 * Get a value from a context-provided cache
 */
export function getFromCache<T>(
  cache: Map<string, unknown> | undefined,
  key: string,
): T | undefined {
  if (!cache) {
    return undefined;
  }
  return cache.get(key) as T | undefined;
}

/**
 * Set a value in a context-provided cache
 */
export function setInCache<T>(
  cache: Map<string, unknown> | undefined,
  key: string,
  value: T,
): void {
  if (cache) {
    cache.set(key, value);
  }
}

// ============================================================================
// AsyncLocalStorage-based helpers (for non-tRPC contexts)
// ============================================================================

/**
 * Run a callback with request-scoped caching enabled
 * All cache operations within the callback will share the same cache
 */
export function runWithRequestCache<T>(callback: () => T): T {
  const store: RequestCacheStore = {
    cache: new Map(),
  };
  return requestCacheStorage.run(store, callback);
}

/**
 * Run an async callback with request-scoped caching enabled
 */
export async function runWithRequestCacheAsync<T>(
  callback: () => Promise<T>,
): Promise<T> {
  const store: RequestCacheStore = {
    cache: new Map(),
  };
  return requestCacheStorage.run(store, callback);
}

/**
 * Get a value from the request cache
 * Returns undefined if not in a request context or key doesn't exist
 */
export function getFromRequestCache<T>(key: string): T | undefined {
  const store = requestCacheStorage.getStore();
  if (!store) {
    return undefined;
  }
  return store.cache.get(key) as T | undefined;
}

/**
 * Set a value in the request cache
 * No-op if not in a request context
 */
export function setInRequestCache<T>(key: string, value: T): void {
  const store = requestCacheStorage.getStore();
  if (!store) {
    return;
  }
  store.cache.set(key, value);
}

/**
 * Check if we're currently in a request context with caching enabled
 */
export function hasRequestCache(): boolean {
  return requestCacheStorage.getStore() !== undefined;
}

/**
 * Get or compute a value from the request cache
 * If the key doesn't exist, the factory function is called and result is cached
 *
 * IMPORTANT: This handles concurrent requests for the same key by storing
 * the pending promise in the cache. If multiple calls happen simultaneously,
 * they will all await the same promise instead of computing multiple times.
 */
export async function getOrComputeRequestCache<T>(
  key: string,
  factory: () => Promise<T>,
): Promise<T> {
  const cached = getFromRequestCache<T>(key);
  if (cached !== undefined) {
    return cached;
  }

  // Check if there's already a pending computation for this key
  const pendingKey = PENDING_PREFIX + key;
  const pending = getFromRequestCache<Promise<T>>(pendingKey);
  if (pending) {
    // Another call is already computing this, wait for it
    return pending;
  }

  // Start the computation and store the promise
  const promise = factory();
  setInRequestCache(pendingKey, promise);

  try {
    const value = await promise;
    // Store the final result
    setInRequestCache(key, value);
    // Clean up the pending promise
    deleteFromRequestCache(pendingKey);
    return value;
  } catch (error) {
    // Clean up the pending promise on error
    deleteFromRequestCache(pendingKey);
    throw error;
  }
}

/**
 * Synchronous version of getOrComputeRequestCache
 */
export function getOrComputeRequestCacheSync<T>(
  key: string,
  factory: () => T,
): T {
  const cached = getFromRequestCache<T>(key);
  if (cached !== undefined) {
    return cached;
  }

  const value = factory();
  setInRequestCache(key, value);
  return value;
}

/**
 * Delete a value from the request cache
 */
export function deleteFromRequestCache(key: string): boolean {
  const store = requestCacheStorage.getStore();
  if (!store) {
    return false;
  }
  return store.cache.delete(key);
}

/**
 * Clear all values from the request cache
 */
export function clearRequestCache(): void {
  const store = requestCacheStorage.getStore();
  if (store) {
    store.cache.clear();
  }
}

/**
 * Get the current size of the request cache
 */
export function getRequestCacheSize(): number {
  const store = requestCacheStorage.getStore();
  return store?.cache.size ?? 0;
}

// ============================================================================
// Cache Key Generators - Centralized to ensure consistency
// ============================================================================

/**
 * Create a cache key for portfolio value requests
 */
export function createPortfolioCacheKey(
  userId: string,
  accountId?: string,
): string {
  return accountId ? `portfolio:${userId}:${accountId}` : `portfolio:${userId}`;
}

/**
 * Create a cache key for user base currency
 */
export function createBaseCurrencyCacheKey(userId: string): string {
  return `baseCurrency:${userId}`;
}

/**
 * Create a cache key for token lookup by symbol
 */
export function createTokenBySymbolCacheKey(symbol: string): string {
  return `token:symbol:${symbol.toUpperCase()}`;
}

/**
 * Create a cache key for token lookup by ID
 */
export function createTokenByIdCacheKey(tokenId: string): string {
  return `token:id:${tokenId}`;
}

/**
 * Create a cache key for currency conversion rate
 */
export function createCurrencyRateCacheKey(
  fromCurrency: string,
  toCurrency: string,
): string {
  return `rate:${fromCurrency.toUpperCase()}:${toCurrency.toUpperCase()}`;
}

/**
 * Create a cache key for user holdings
 */
export function createUserHoldingsCacheKey(
  userId: string,
  accountId?: string,
): string {
  return accountId ? `holdings:${userId}:${accountId}` : `holdings:${userId}`;
}

/**
 * Create a cache key for user accounts
 */
export function createUserAccountsCacheKey(userId: string): string {
  return `accounts:${userId}`;
}
