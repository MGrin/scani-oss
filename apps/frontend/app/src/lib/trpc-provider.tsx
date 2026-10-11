import { showError } from '@scani/ui/ui/use-toast';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink, splitLink, TRPCClientError } from '@trpc/client';
import i18n from 'i18next';
import { useEffect, useState } from 'react';
import { authClient } from './auth-client';
import { QUERY_DEFAULTS } from './query-defaults';
import { trpc } from './trpc';
import { getTrpcAuthHeaders } from './trpc-auth-headers';
import { trpcBatchLane } from './trpc-batch-lane';

const isNetworkError = (error: unknown): boolean => {
  if (error instanceof TRPCClientError && error.data?.code === 'UNAUTHORIZED') return false;
  const message = error instanceof Error ? error.message : String(error);
  return /Failed to fetch|NetworkError|Load failed/i.test(message);
};

interface TRPCProviderProps {
  children: React.ReactNode;
}

export function TRPCProvider({ children }: TRPCProviderProps) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({
          onError: (error) => {
            if (isNetworkError(error)) showError(error, i18n.t('offline.connectionIssueRetrying'));
          },
        }),
        mutationCache: new MutationCache({
          onError: (error, _variables, _context, mutation) => {
            // React Query v4 fires this alongside the mutation's own local `onError`
            // (if any) for the same error — skip the generic toast there so the
            // local handler's context-specific message isn't raced/overridden.
            if (mutation.options.onError) return;
            if (isNetworkError(error)) showError(error, i18n.t('offline.connectionIssue'));
          },
        }),
        defaultOptions: {
          queries: QUERY_DEFAULTS,
          mutations: {
            networkMode: 'online',
            // A lost response may follow a committed write. Retrying requires an idempotency key.
            retry: false,
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
        splitLink({
          condition: (op) => trpcBatchLane(op.path) === 'dashboard',
          true: makeBatchLink(),
          false: splitLink({
            condition: (op) => trpcBatchLane(op.path) === 'returns',
            true: makeBatchLink(),
            false: splitLink({
              condition: (op) => trpcBatchLane(op.path) === 'income',
              true: makeBatchLink(),
              false: splitLink({
                condition: (op) => trpcBatchLane(op.path) === 'review',
                true: makeBatchLink(),
                false: makeBatchLink(),
              }),
            }),
          }),
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
