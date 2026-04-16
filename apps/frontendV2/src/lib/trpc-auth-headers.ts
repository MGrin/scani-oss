import { supabase } from './supabase';

/**
 * Shared tRPC auth-header logic for both the React Query client (used
 * throughout the app via hooks) and the vanilla proxy client (used in
 * ExchangeConnectDialog for dynamic router-path access).
 *
 * Both clients need to:
 *   1. Read the current Supabase access token before every request.
 *   2. Refresh the token if it's expired or about to expire, so long-
 *      lived sessions don't hit 401s mid-flight.
 *   3. Bound both operations with timeouts so a hung Supabase fetch
 *      can't lock the entire UI.
 *
 * Duplicating this logic between two files was fragile — the React
 * provider had it, the vanilla client didn't, and it was easy to drift.
 * Hoisting it here keeps them in sync.
 */

const GET_SESSION_TIMEOUT_MS = 5000;
const REFRESH_SESSION_TIMEOUT_MS = 8000;
const TOKEN_REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export async function getTrpcAuthHeaders(): Promise<Record<string, string>> {
  try {
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

    if (!session) {
      return { authorization: '' };
    }

    // Check if token has expired or will expire soon
    if (session.expires_at) {
      const expiresAt = session.expires_at * 1000;
      const timeUntilExpiry = expiresAt - Date.now();

      if (timeUntilExpiry < TOKEN_REFRESH_THRESHOLD_MS) {
        console.log(
          `[tRPC] Token ${timeUntilExpiry < 0 ? 'expired' : 'expiring soon'}, refreshing session`
        );

        try {
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
            return { authorization: `Bearer ${session.access_token}` };
          }

          if (refreshData.session) {
            return { authorization: `Bearer ${refreshData.session.access_token}` };
          }
        } catch (refreshException) {
          console.error('[tRPC] Exception while refreshing session:', refreshException);
          return { authorization: `Bearer ${session.access_token}` };
        }
      }
    }

    return { authorization: `Bearer ${session.access_token}` };
  } catch (error) {
    console.error('[tRPC] Unexpected error in headers function:', error);
    return { authorization: '' };
  }
}
