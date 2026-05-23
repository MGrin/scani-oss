import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink, splitLink, TRPCClientError } from '@trpc/client';
import { useEffect, useState } from 'react';
import { authClient } from './auth-client';
import { trpc } from './trpc';
import { getTrpcAuthHeaders } from './trpc-auth-headers';

interface TRPCProviderProps {
  children: React.ReactNode;
}

export function TRPCProvider({ children }: TRPCProviderProps) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
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
            refetchOnWindowFocus: false, // Don't refetch on window focus
            refetchOnReconnect: true, // Refetch on reconnect only
            networkMode: 'online',
            retry: (failureCount, error) => {
              // Don't retry on 401 errors
              if (error instanceof TRPCClientError && error.data?.code === 'UNAUTHORIZED') {
                return false;
              }
              return failureCount < 3;
            },
          },
          mutations: {
            networkMode: 'online',
            retry: (failureCount, error) => {
              // Don't retry on 401 errors
              if (error instanceof TRPCClientError && error.data?.code === 'UNAUTHORIZED') {
                return false;
              }
              return failureCount < 1;
            },
          },
        },
      })
  );

  // Global error handler for authentication issues
  useEffect(() => {
    const handleQueryError = (error: unknown) => {
      if (error instanceof TRPCClientError) {
        // Check if it's an UNAUTHORIZED error
        if (error.data?.code === 'UNAUTHORIZED') {
          console.warn('[Auth] Unauthorized request detected, redirecting to auth page');

          // Clear any stale session on the server + cookie
          authClient.signOut().catch(console.error);

          // Redirect to auth page with return URL
          const currentPath = window.location.pathname + window.location.search;
          const returnUrl =
            currentPath !== '/auth' ? `?returnTo=${encodeURIComponent(currentPath)}` : '';
          window.location.href = `/auth${returnUrl}`;
        }
      }
    };

    // Set up error handler on the query cache
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'observerResultsUpdated' && event.query.state.error) {
        handleQueryError(event.query.state.error);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [queryClient]);

  // Auth headers logic lives in `trpc-auth-headers.ts` so any future
  // sibling tRPC client (background worker, vanilla proxy) can reuse
  // the same session-refresh path without drifting.
  const [trpcClient] = useState(() => {
    const makeBatchLink = () =>
      httpBatchLink({
        url: `${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/trpc`,
        // Send the Better-Auth session cookie on every tRPC call.
        fetch(url, options) {
          return fetch(url, { ...options, credentials: 'include' });
        },
        async headers() {
          return getTrpcAuthHeaders();
        },
      });

    return trpc.createClient({
      links: [
        // `dashboard.*` (getOverview / getAssetAllocation) are CPU-heavy
        // whole-portfolio valuation passes. Sharing one HTTP batch with the
        // light dashboard procedures gated the entire page on the slowest
        // call — a batch response cannot return until every procedure in it
        // resolves. Routing them to a dedicated batch lets the rest of the
        // dashboard render while valuation is still in flight; the two heavy
        // procedures stay batched together so the server's per-request cache
        // still dedupes the valuation across them.
        splitLink({
          condition: (op) => op.path.startsWith('dashboard.'),
          true: makeBatchLink(),
          false: makeBatchLink(),
        }),
      ],
    });
  });

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
