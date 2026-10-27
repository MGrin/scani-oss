import { httpStatus } from '@scani/ui/lib/user-facing-error';
import type { DefaultOptions } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';

/** How long a query that ended in a transient failure waits before asking again (SC-1772). */
const TRANSIENT_FAILURE_REFETCH_MS = 15_000;

/**
 * A 4xx the server wrote is an answer, and asking again gets the same one.
 * Anything else ends when the server recovers: no answer, a proxy's HTML page
 * (which carries no status the client can read), a 5xx, a timeout, a rate limit.
 */
function isTransientFailure(error: unknown): boolean {
  const status = httpStatus(error);
  return status === null || status >= 500 || status === 408 || status === 429;
}

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
  // Three retries span about 7 s, and a Neon compute restart or a proxy 502
  // outlasts that. The query then stayed on its error card after the server
  // was back, until a tap or a focus change (SC-1772). Paused while the app
  // is hidden, like every interval here.
  refetchInterval: (_data, query) =>
    query.state.status === 'error' && isTransientFailure(query.state.error)
      ? TRANSIENT_FAILURE_REFETCH_MS
      : false,
  retry: (failureCount, error) => {
    // Don't retry on 401 errors
    if (error instanceof TRPCClientError && error.data?.code === 'UNAUTHORIZED') {
      return false;
    }
    return failureCount < 3;
  },
};
