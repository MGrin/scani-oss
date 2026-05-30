import type { AppRouter } from '@scani/data-provider/types';
import { createTRPCProxyClient, httpBatchLink } from '@trpc/client';

// In production VITE_DATA_PROVIDER_URL is `https://api.cloud.scani.xyz`
// (set at deploy time in the landing deploy step). In dev it's empty
// and the form posts to a relative `/trpc/...` URL — wire the dev-server
// proxy in vite.config.ts if/when local contact-form testing is desired.
const dataProviderUrl = import.meta.env.VITE_DATA_PROVIDER_URL || '';

export const trpc = createTRPCProxyClient<AppRouter>({
  links: [
    httpBatchLink({
      url: dataProviderUrl ? `${dataProviderUrl}/trpc` : '/trpc',
    }),
  ],
});
