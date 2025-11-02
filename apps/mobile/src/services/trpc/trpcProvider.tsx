import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { httpBatchLink, TRPCClientError } from '@trpc/client';
import { useRouter } from 'expo-router';
import { type FC, type ReactNode, useEffect, useState } from 'react';

import { supabase } from '@/services/supabase/supabase';
import { logger } from '@/utils/logger';

import { mmkvPersister } from './mmkvPersister';
import { trpc } from './trpc';

interface TRPCProviderProps {
  children: ReactNode;
}

export const TRPCProvider: FC<TRPCProviderProps> = ({ children }) => {
  const router = useRouter();

  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            gcTime: 1000 * 60 * 5,
            staleTime: 1000 * 60,
            refetchOnWindowFocus: true,
            refetchOnMount: false,
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
    const handleQueryError = (error: unknown) => {
      if (error instanceof TRPCClientError) {
        if (error.data?.code === 'UNAUTHORIZED') {
          logger.warn('Unauthorized tRPC request detected', {
            code: error.data.code,
            message: error.message,
          });

          supabase.auth.signOut().catch((signOutError) => {
            logger.error('Failed to sign out after unauthorized request', signOutError);
          });
          router.replace('/(auth)');
        }
      }
    };

    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'observerResultsUpdated' && event.query.state.error) {
        handleQueryError(event.query.state.error);
      }
    });

    return () => unsubscribe();
  }, [queryClient, router]);

  const [trpcClient] = useState(() => {
    const apiUrl = process.env.EXPO_PUBLIC_API_URL
      ? `${process.env.EXPO_PUBLIC_API_URL}/trpc`
      : 'http://localhost:3001/trpc';

    logger.info('Initializing tRPC client', { apiUrl });

    return trpc.createClient({
      links: [
        httpBatchLink({
          url: apiUrl,

          async headers() {
            const {
              data: { session },
            } = await supabase.auth.getSession();

            if (session?.access_token) {
              logger.debug('Adding auth token to tRPC request');
            }

            return {
              authorization: session?.access_token ? `Bearer ${session.access_token}` : '',
            };
          },
        }),
      ],
    });
  });

  const persistOptions = {
    persister: mmkvPersister,
    maxAge: 1000 * 60 * 60 * 24,
    dehydrateOptions: {
      shouldDehydrateQuery: (query: any) => {
        return query.state.status === 'success';
      },
    },
  };

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={persistOptions}
        onSuccess={() => {
          queryClient.resumePausedMutations();
        }}
      >
        {children}
      </PersistQueryClientProvider>
    </trpc.Provider>
  );
};
