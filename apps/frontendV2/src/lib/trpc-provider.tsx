import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink, TRPCClientError } from '@trpc/client';
import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { trpc } from './trpc';

interface TRPCProviderProps {
  children: React.ReactNode;
}

export function TRPCProvider({ children }: TRPCProviderProps) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnMount: true,
            refetchOnWindowFocus: true,
            refetchOnReconnect: true,
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

          // Sign out from Supabase to clear any stale session
          supabase.auth.signOut().catch(console.error);

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

  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: `${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/trpc`,
          // Include auth token in headers
          async headers() {
            // Get session - this will automatically refresh the token if needed
            const {
              data: { session },
              error,
            } = await supabase.auth.getSession();

            if (error) {
              console.error('[tRPC] Error getting session:', error);
            }

            // If no session or token is close to expiry, try to refresh
            if (session?.expires_at) {
              const expiresAt = session.expires_at * 1000; // Convert to ms
              const now = Date.now();
              const timeUntilExpiry = expiresAt - now;
              const fiveMinutes = 5 * 60 * 1000;

              // If token expires in less than 5 minutes, refresh it
              if (timeUntilExpiry < fiveMinutes) {
                console.log('[tRPC] Token expiring soon, refreshing session');
                const { data: refreshData, error: refreshError } =
                  await supabase.auth.refreshSession();
                if (refreshError) {
                  console.error('[tRPC] Error refreshing session:', refreshError);
                } else if (refreshData.session) {
                  return {
                    authorization: `Bearer ${refreshData.session.access_token}`,
                  };
                }
              }
            }

            return {
              authorization: session?.access_token ? `Bearer ${session.access_token}` : '',
            };
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
}
