import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink, TRPCClientError } from '@trpc/client';
import { type ReactNode, useEffect, useState } from 'react';

/**
 * Factory for a tRPC + React-Query provider.
 *
 * Each SPA instantiates its own `trpc` React client (keyed by its own
 * AppRouter type) via `createTRPCReact<AppRouter>()` and hands it to
 * `createTrpcProvider`, which encapsulates the QueryClient defaults and
 * the unauthorized-error handler that both apps need.
 *
 * Callers supply:
 *   - `trpc`: the React client instance
 *   - `url`: the /trpc endpoint URL
 *   - `onUnauthorized`: what to do when a 401 surfaces (redirect to /auth,
 *     sign out, etc.). This is app-specific — frontendV2 redirects to its
 *     /auth page with returnTo query param; cloud-frontend does the same
 *     against its own /auth route.
 */

// The concrete type of `trpc` is `ReturnType<typeof createTRPCReact<AppRouter>>`
// which varies per app. We accept it loosely here because tRPC's branded
// property guards break structural subtyping across app boundaries; each
// caller passes its own typed `trpc` client in directly.
export interface TrpcProviderFactoryOptions {
  // biome-ignore lint/suspicious/noExplicitAny: trpc client shape varies per app
  trpc: any;
  url: string;
  onUnauthorized?: () => void;
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
}

export function createTrpcProvider(options: TrpcProviderFactoryOptions) {
  const { trpc, url, onUnauthorized, headers } = options;

  return function TrpcProvider({ children }: { children: ReactNode }) {
    const [queryClient] = useState(
      () =>
        new QueryClient({
          defaultOptions: {
            queries: {
              staleTime: 30 * 1000,
              cacheTime: 5 * 60 * 1000,
              refetchOnMount: true,
              refetchOnWindowFocus: false,
              refetchOnReconnect: true,
              networkMode: 'online',
              retry: (failureCount, error) => {
                if (error instanceof TRPCClientError && error.data?.code === 'UNAUTHORIZED') {
                  return false;
                }
                return failureCount < 3;
              },
            },
            mutations: {
              networkMode: 'online',
              retry: (failureCount, error) => {
                if (error instanceof TRPCClientError && error.data?.code === 'UNAUTHORIZED') {
                  return false;
                }
                return failureCount < 1;
              },
            },
          },
        })
    );

    useEffect(() => {
      if (!onUnauthorized) return;
      const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
        if (event.type === 'observerResultsUpdated' && event.query.state.error) {
          const err = event.query.state.error;
          if (err instanceof TRPCClientError && err.data?.code === 'UNAUTHORIZED') {
            onUnauthorized();
          }
        }
      });
      return () => {
        unsubscribe();
      };
    }, [queryClient]);

    const [trpcClient] = useState(() =>
      trpc.createClient({
        links: [
          httpBatchLink({
            url,
            fetch(u, o) {
              return fetch(u, { ...o, credentials: 'include' });
            },
            async headers() {
              return headers ? await headers() : {};
            },
          }),
        ],
      })
    );

    return (
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </trpc.Provider>
    );
  };
}
