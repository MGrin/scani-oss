import { emailOTPClient, magicLinkClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/**
 * Better-Auth browser client talking to apps/data-provider.
 *
 * `baseURL` points at /api/auth on the same origin — in dev the Vite
 * proxy (see vite.config.ts) forwards to the data-provider on port
 * 8082; in prod the Cloudflare Pages build uses an absolute URL so the
 * session cookie is issued by the data-provider domain directly.
 *
 * Better-Auth's client validates `baseURL` with `new URL(...)` at
 * construction time, which rejects relative paths. So we resolve the
 * dev fallback against `window.location.origin` rather than passing
 * `/api/auth` directly. SSR isn't a concern here — this app only ever
 * runs in the browser.
 *
 * We instantiate `createAuthClient` directly (rather than go through
 * `@scani/frontend-shared`'s factory) so tsgo keeps the specific plugin
 * types and tools like `authClient.emailOtp.sendVerificationOtp` stay
 * typed end-to-end.
 */
const baseURL = import.meta.env.VITE_DATA_PROVIDER_URL
  ? `${import.meta.env.VITE_DATA_PROVIDER_URL}/api/auth`
  : `${window.location.origin}/api/auth`;

export const authClient = createAuthClient({
  baseURL,
  fetchOptions: {
    credentials: 'include',
  },
  plugins: [magicLinkClient(), emailOTPClient()],
});

export type AuthClient = typeof authClient;
