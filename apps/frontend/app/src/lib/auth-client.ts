import { LANGUAGE_HEADER } from '@scani/shared';
import { emailOTPClient, magicLinkClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import i18n from '@/i18n';
import { apiBaseUrl } from '@/lib/api-base-url';
import { fetchWithDeadline } from '@/lib/auth-network';

/**
 * Better-Auth client. `baseURL` points at the backend's /api/auth/* mount.
 * In dev, VITE_API_URL=http://localhost:3001; in production,
 * https://api.scani.xyz.
 *
 * Resolved through `apiBaseUrl()` rather than read raw, because the published
 * `scani/frontend-app` image is built with `VITE_API_URL=/api` so one artefact
 * can serve any hostname — and `createAuthClient` throws
 * `BetterAuthError: Invalid base URL: /api` on a relative value, at MODULE
 * scope, which white-screened every self-host install (SC-467).
 */
const baseURL = apiBaseUrl();

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
    // The reader's interface language, on every auth request (SC-412).
    //
    // This is the only way the language reaches the letter: the sender is
    // signed out, so there is no stored preference to read, and the sign-in
    // mail is the one step of the flow that leaves the browser. Read here
    // rather than captured at module load because the language can change
    // after this file runs — and read from i18next rather than
    // `navigator.language`, because the DEVICE's language is exactly what
    // this app refuses to let decide anything (SC-175, SC-201).
    //
    // On every request rather than at the two sign-in call sites: sign-up
    // verification and change-email also send mail, from screens that have no
    // idea one is about to go out.
    onRequest: (context) => {
      if (i18n.language) context.headers.set(LANGUAGE_HEADER, i18n.language);
      return context;
    },
  },
  plugins: [magicLinkClient(), emailOTPClient()],
});
