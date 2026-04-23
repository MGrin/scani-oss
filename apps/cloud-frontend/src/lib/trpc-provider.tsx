import { createTrpcProvider } from '@scani/frontend-shared';
import { trpc } from './trpc';

const dataProviderUrl = import.meta.env.VITE_DATA_PROVIDER_URL || '';

export const TrpcProvider = createTrpcProvider({
  trpc,
  url: dataProviderUrl ? `${dataProviderUrl}/trpc` : '/trpc',
  onUnauthorized: () => {
    // Redirect to /auth preserving where the user was going.
    const current = window.location.pathname + window.location.search;
    if (!current.startsWith('/auth')) {
      window.location.href = `/auth?returnTo=${encodeURIComponent(current)}`;
    }
  },
});
