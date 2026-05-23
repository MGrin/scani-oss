import { emailOTPClient, magicLinkClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/**
 * Better-Auth client. `baseURL` points at the backend's /api/auth/* mount.
 * In dev, VITE_API_URL=http://localhost:3001; in production,
 * https://api.example.com.
 */
const baseURL = import.meta.env.VITE_API_URL;
if (!baseURL) {
  throw new Error('VITE_API_URL is required');
}

export const authClient = createAuthClient({
  baseURL,
  // Include the session cookie on every request. The backend's CORS config
  // already sets credentials: true and allows the api.example.com origin.
  fetchOptions: {
    credentials: 'include',
  },
  plugins: [magicLinkClient(), emailOTPClient()],
});

// Re-exports so the rest of the app can import React hooks ergonomically.
export const { signIn, signOut, signUp, useSession } = authClient;
