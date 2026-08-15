import { emailOTPClient, magicLinkClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { fetchWithDeadline } from '@/lib/auth-network';

/**
 * Better-Auth client. `baseURL` points at the backend's /api/auth/* mount.
 * In dev, VITE_API_URL=http://localhost:3001; in production,
 * https://api.scani.xyz.
 */
const baseURL = import.meta.env.VITE_API_URL;
if (!baseURL) {
  throw new Error('VITE_API_URL is required');
}

export const authClient = createAuthClient({
  baseURL,
  // Include the session cookie on every request. The backend's CORS config
  // already sets credentials: true and allows the api.scani.xyz origin.
  fetchOptions: {
    credentials: 'include',
    // Every auth request gets a deadline, here rather than at each call site,
    // so the cold-start session probe is covered too — it is the request that
    // decides whether an offline launch shows the app or the sign-in screen
    // (SC-78 §1 and §2).
    customFetchImpl: (input, init) =>
      fetchWithDeadline(input as string | URL | Request, init as RequestInit | undefined),
  },
  plugins: [magicLinkClient(), emailOTPClient()],
});

// Re-exports so the rest of the app can import React hooks ergonomically.
export const { signIn, signOut, signUp, useSession } = authClient;
