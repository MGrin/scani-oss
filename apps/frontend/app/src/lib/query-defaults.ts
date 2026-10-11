import type { DefaultOptions } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';

/** The app's query defaults, in their own module so a test can build a client with them. */
export const QUERY_DEFAULTS: NonNullable<DefaultOptions['queries']> = {
  staleTime: 30 * 1000, // Consider data fresh for 30 seconds
  cacheTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
  // Refetch on mount when the cached data is stale. Combined with
  // `staleTime: 30s`, this means: within 30s of last fetch the cache
  // is served instantly, after 30s (or after an `invalidate()` call
  // which marks stale immediately) the data is refetched on next
  // mount. Previously this was `false`, which caused a subtle bug:
  // post-mutation `.invalidate()` calls that then navigated to a
  // list page served stale cached data on arrival, because the
  // invalidated query had no active observers at invalidation time
  // and `refetchOnMount: false` skipped the refetch on mount.
  refetchOnMount: true,
  // A tab left open overnight showed yesterday's figures until a navigation
  // (SC-1599). Only queries on screen AND older than `staleTime` refetch, so
  // switching windows within 30s costs nothing.
  refetchOnWindowFocus: true,
  refetchOnReconnect: true, // Refetch on reconnect only
  networkMode: 'online',
  retry: (failureCount, error) => {
    // Don't retry on 401 errors
    if (error instanceof TRPCClientError && error.data?.code === 'UNAUTHORIZED') {
      return false;
    }
    return failureCount < 3;
  },
};
