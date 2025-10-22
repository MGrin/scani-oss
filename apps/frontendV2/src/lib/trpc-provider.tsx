import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { useState } from "react";
import { supabase } from "./supabase";
import { trpc } from "./trpc";

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
            networkMode: "online",
          },
          mutations: {
            // retry: 1, // Retry once for transient failures
            networkMode: "online",
          },
        },
      })
  );

  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: `${
            import.meta.env.VITE_API_URL || "http://localhost:3001"
          }/trpc`,
          // Include auth token in headers
          async headers() {
            const {
              data: { session },
            } = await supabase.auth.getSession();

            return {
              authorization: session?.access_token
                ? `Bearer ${session.access_token}`
                : "",
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
