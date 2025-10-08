import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { useState } from 'react';
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
            retry: 1,
            refetchOnWindowFocus: false,
            // CRITICAL FIX: Reduce stale time to prevent cache issues
            staleTime: 30 * 1000, // 30 seconds (was 5 minutes)
            cacheTime: 5 * 60 * 1000, // 5 minutes (was 10 minutes)
            refetchOnMount: 'always', // Always refetch to ensure fresh data (was false)
            refetchOnReconnect: true, // Enable background refetch for stale queries
            networkMode: 'online', // Prevent multiple identical requests in flight
          },
          mutations: {
            retry: 1, // Add retry logic for transient failures
            networkMode: 'online',
          },
        },
      })
  );

  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: `${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/trpc`,
          // Include auth token in headers
          async headers() {
            const {
              data: { session },
            } = await supabase.auth.getSession();

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
