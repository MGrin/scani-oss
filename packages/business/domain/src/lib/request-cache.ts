// Request-scoped cache for deduplicating expensive computations within
// a single tRPC batch.
//
// Pattern: tRPC creates a `requestCache: Map<string, unknown>` per
// incoming HTTP request and threads it through `ctx`. Domain services
// that compute the same thing across multiple procedures (DashboardService
// + AssetAllocationService both want the user's holdings) call
// `getOrComputeFromCache(requestCache, key, factory)` and naturally
// share the work.
//
// Concurrent factory invocations against the same key share one
// promise — important for tRPC batches where N procedures fire in
// parallel within the same request and would otherwise compute the
// same expensive holdings query N times.
//
// `requestCache` is intentionally optional: when undefined (background
// jobs, scripts, tests without a request boundary) the helper falls
// through to direct execution.
//
// Two surfaces:
//   1. Context-based (`getOrComputeFromCache`) — caller passes the
//      Map<string, unknown> from `ctx.requestCache`. Works inside tRPC
//      batches where each procedure is a separate async context.
//   2. AsyncLocalStorage-based (`getOrComputeRequestCache`) — for
//      non-tRPC code paths (worker jobs, scripts) that want to opt
//      into request-scope caching by wrapping work in
//      `runWithRequestCacheAsync`. Falls through to direct execution
//      when no AsyncLocalStorage is bound. Imported from
//      `node:async_hooks`, so this module is backend-only — never
//      reachable from the frontend bundle.

import { AsyncLocalStorage } from 'node:async_hooks';

const PENDING_PREFIX = '__pending__';

interface RequestCacheStore {
  cache: Map<string, unknown>;
}

const requestCacheStorage = new AsyncLocalStorage<RequestCacheStore>();

export async function getOrComputeFromCache<T>(
  cache: Map<string, unknown> | undefined,
  key: string,
  factory: () => Promise<T>
): Promise<T> {
  if (!cache) return factory();

  const cached = cache.get(key);
  if (cached !== undefined) return cached as T;

  const pendingKey = PENDING_PREFIX + key;
  const pending = cache.get(pendingKey) as Promise<T> | undefined;
  if (pending) return pending;

  const promise = factory();
  cache.set(pendingKey, promise);

  try {
    const value = await promise;
    cache.set(key, value);
    cache.delete(pendingKey);
    return value;
  } catch (error) {
    cache.delete(pendingKey);
    throw error;
  }
}

/** Run an async callback inside a request-scope. Cache reads/writes via
 *  `getOrComputeRequestCache` see the same Map for the duration of the
 *  callback; callers outside the run() are isolated. */
export async function runWithRequestCacheAsync<T>(callback: () => Promise<T>): Promise<T> {
  return requestCacheStorage.run({ cache: new Map() }, callback);
}

/** Whether the current async context is wrapped by `runWithRequestCacheAsync`. */
export function hasRequestCache(): boolean {
  return requestCacheStorage.getStore() !== undefined;
}

/** Get-or-compute against the AsyncLocalStorage-bound request cache.
 *  Falls through to direct execution when no AsyncLocalStorage is bound. */
export async function getOrComputeRequestCache<T>(
  key: string,
  factory: () => Promise<T>
): Promise<T> {
  const store = requestCacheStorage.getStore();
  if (!store) return factory();
  return getOrComputeFromCache(store.cache, key, factory);
}

/** Cache key for portfolio-value computations. Centralised so the
 *  multiple call sites stay in sync — changing the key shape in one
 *  place would otherwise silently bypass the dedup. */
export function createPortfolioCacheKey(userId: string, accountId?: string): string {
  return accountId ? `portfolio:${userId}:${accountId}` : `portfolio:${userId}`;
}
