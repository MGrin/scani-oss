import { emailOTPClient, magicLinkClient } from 'better-auth/client/plugins';
import { createAuthClient as createBetterAuthClient } from 'better-auth/react';

/**
 * Factory for the Better-Auth React client.
 *
 * frontendV2 points `baseURL` at the backend (`api.scani.xyz`);
 * cloud-frontend points it at the data-provider (`api.cloud.scani.xyz`). Both
 * include credentials so the signed session cookie rides along with every
 * request, and both ship the magic-link + email-OTP client plugins so the
 * auth UI works identically.
 */
export interface CreateAuthClientOptions {
  baseURL: string;
  /** Extra plugins to append after magicLink + emailOTP. Most callers leave this empty. */
  // biome-ignore lint/suspicious/noExplicitAny: better-auth plugin types are generic across versions
  extraPlugins?: any[];
}

export function createScaniAuthClient({ baseURL, extraPlugins = [] }: CreateAuthClientOptions) {
  return createBetterAuthClient({
    baseURL,
    fetchOptions: {
      credentials: 'include',
    },
    plugins: [magicLinkClient(), emailOTPClient(), ...extraPlugins],
  });
}

export type ScaniAuthClient = ReturnType<typeof createScaniAuthClient>;
