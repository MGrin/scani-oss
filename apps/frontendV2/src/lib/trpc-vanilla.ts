import type { AppRouter } from '@scani/backend/types';
import { createTRPCProxyClient, httpBatchLink } from '@trpc/client';
import { getTrpcAuthHeaders } from './trpc-auth-headers';

/**
 * Vanilla tRPC proxy client — a sibling to the React-Query-flavoured
 * client in `trpc-provider.tsx`.
 *
 * Why a second client?
 * --------------------
 * `createTRPCReact<AppRouter>()` returns a React-aware proxy where the
 * leaves are hooks (`.useMutation()`, `.useQuery()`), NOT method
 * calls. Any code that needs to invoke a procedure by a dynamic path
 * string — e.g. `integrations[exchangeKey].validateKeys` — can't go
 * through the React client, because:
 *   1. Hooks can't be called conditionally or inside event handlers.
 *   2. Accessing `.mutate` on the React proxy returns another proxy
 *      node, not a callable, which then throws "X is not a function"
 *      (or its minified form `t[s] is not a function`) when invoked.
 *
 * `createTRPCProxyClient` from `@trpc/client` returns a *vanilla*
 * proxy where the leaves are real `.query()` and `.mutate()` methods
 * that return promises. That's exactly what dynamic paths need.
 *
 * Auth headers come from the shared `getTrpcAuthHeaders` helper so
 * this client stays in sync with the React client's session-refresh
 * and timeout behaviour — there's exactly one source of truth for
 * "how to talk to the backend".
 *
 * Prefer the React client (`import { trpc } from '@/lib/trpc'`) for
 * everything else: it integrates with React Query's cache,
 * invalidation, and loading states. Only reach for this vanilla
 * client when you specifically need dynamic router-path access that
 * can't be expressed as a static hook call at the top of a component.
 */
export const trpcVanilla = createTRPCProxyClient<AppRouter>({
  links: [
    httpBatchLink({
      url: `${import.meta.env.VITE_API_URL || 'http://localhost:3001'}/trpc`,
      async headers() {
        return getTrpcAuthHeaders();
      },
    }),
  ],
});
