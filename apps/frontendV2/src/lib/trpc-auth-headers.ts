/**
 * tRPC auth-header provider.
 *
 * Under Better-Auth, authentication is a cookie on the api host (set by
 * the backend after signin). The browser automatically attaches it on
 * every request as long as the fetch is invoked with
 * `credentials: 'include'` — which the tRPC client is configured to do
 * (see trpc-provider.tsx).
 *
 * Headers stay empty because the cookie carries the session. We keep
 * the function for API compatibility with callers that expect a
 * `headers()` thunk.
 */
export async function getTrpcAuthHeaders(): Promise<Record<string, string>> {
  return {};
}
