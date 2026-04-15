import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink, TRPCClientError } from '@trpc/client';
import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { trpc } from './trpc';

interface TRPCProviderProps {
  children: React.ReactNode;
}

// Timeout constants for auth operations
const GET_SESSION_TIMEOUT_MS = 5000; // 5 seconds
const REFRESH_SESSION_TIMEOUT_MS = 8000; // 8 seconds
const TOKEN_REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

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
            try {
              // Get session with timeout to prevent hanging
              const sessionPromise = supabase.auth.getSession();
              const timeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error('getSession timeout')), GET_SESSION_TIMEOUT_MS);
              });

              const {
                data: { session },
                error,
              } = await Promise.race([sessionPromise, timeoutPromise]);

              if (error) {
                console.error('[tRPC] Error getting session:', error);
                return { authorization: '' };
              }

              // If no session, return empty auth header
              if (!session) {
                return { authorization: '' };
              }

              // Check if token has expired or will expire soon
              if (session.expires_at) {
                const expiresAt = session.expires_at * 1000; // Convert to ms
                const now = Date.now();
                const timeUntilExpiry = expiresAt - now;

                // If token has already expired or expires in less than threshold, refresh it
                if (timeUntilExpiry < TOKEN_REFRESH_THRESHOLD_MS) {
                  console.log(
                    `[tRPC] Token ${timeUntilExpiry < 0 ? 'expired' : 'expiring soon'}, refreshing session`
                  );

                  try {
                    // Refresh session with timeout
                    const refreshPromise = supabase.auth.refreshSession();
                    const refreshTimeoutPromise = new Promise<never>((_, reject) => {
                      setTimeout(
                        () => reject(new Error('refreshSession timeout')),
                        REFRESH_SESSION_TIMEOUT_MS
                      );
                    });

                    const { data: refreshData, error: refreshError } = await Promise.race([
                      refreshPromise,
                      refreshTimeoutPromise,
                    ]);

                    if (refreshError) {
                      console.error('[tRPC] Error refreshing session:', refreshError);
                      // Return the old token anyway, backend will handle the auth error
                      return {
                        authorization: `Bearer ${session.access_token}`,
                      };
                    }

                    if (refreshData.session) {
                      console.log('[tRPC] Session refreshed successfully');
                      return {
                        authorization: `Bearer ${refreshData.session.access_token}`,
                      };
                    }
                  } catch (refreshException) {
                    console.error('[tRPC] Exception while refreshing session:', refreshException);
                    // Return the old token anyway, backend will handle the auth error
                    return {
                      authorization: `Bearer ${session.access_token}`,
                    };
                  }
                }
              }

              return {
                authorization: `Bearer ${session.access_token}`,
              };
            } catch (error) {
              console.error('[tRPC] Unexpected error in headers function:', error);
              return { authorization: '' };
            }
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
