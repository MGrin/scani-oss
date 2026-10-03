import { TURNSTILE_HEADER } from '@scani/http-fetch';
import { LANGUAGE_HEADER } from '@scani/shared';

/**
 * Browser origins the api answers to.
 *
 * Production accepts `FRONTEND_URL` plus, when configured, the Cloud console
 * origin (`CLOUD_FRONTEND_URL`) — and nothing else.
 *
 * Development additionally accepts loopback on any port. A dev browser
 * arrives from whatever host it was actually pointed at, which is routinely
 * not the one `FRONTEND_URL` names: `127.0.0.1` where the config says
 * `localhost` (automation drivers resolve it that way), or a second
 * worktree's Vite on a port other than 5173. Every one of those mismatches
 * used to be a silent CORS refusal that surfaces in a browser console only
 * as `TypeError: Failed to fetch`, with no server-side error at all.
 *
 * Loopback only — deliberately not the LAN ranges. It covers every observed
 * failure while keeping the dev allowance to origins that already require
 * code execution on this machine.
 */

/** Matches `http(s)://{localhost,127.0.0.1,[::1]}` with an optional port. */
export const LOOPBACK_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;

/**
 * Better-Auth matches `trustedOrigins` with glob patterns rather than
 * regexes, so the loopback allowance is spelled out a second time here.
 * `*` never crosses a `/`, so these cannot widen past the host:port.
 */
const LOOPBACK_TRUSTED_ORIGIN_PATTERNS = [
  'http://localhost',
  'http://localhost:*',
  'http://127.0.0.1',
  'http://127.0.0.1:*',
  'http://[::1]',
  'http://[::1]:*',
  'https://localhost:*',
  'https://127.0.0.1:*',
];

export interface BrowserOriginOptions {
  /** Pass `isNodeEnvProduction()`. Production never gets the dev allowance. */
  isProduction: boolean;
  /** Further exact origins (the Cloud console). Validated as https in production by the env schema. */
  extraOrigins?: readonly string[];
}

function exactOrigins(frontendUrl: string, extraOrigins: readonly string[] = []): string[] {
  return [...new Set([frontendUrl, ...extraOrigins])];
}

/** `origin` value for `@elysiajs/cors`. */
export function buildCorsOrigins(
  frontendUrl: string,
  { isProduction, extraOrigins }: BrowserOriginOptions
): (string | RegExp)[] {
  const exact = exactOrigins(frontendUrl, extraOrigins);
  return isProduction ? exact : [...exact, LOOPBACK_ORIGIN];
}

/**
 * Everything the API passes to `@elysiajs/cors`, in one place so the test
 * exercises the real options rather than a copy (SC-1500).
 *
 * `allowedHeaders`: `LANGUAGE_HEADER` is what the auth client puts the
 * reader's interface language on (SC-412). A custom header makes the sign-in
 * POST preflighted, so omitting it here does not degrade the letter to
 * English — it fails the request outright. `TURNSTILE_HEADER` carries the
 * sign-in widget's token (SC-1266) and fails the same way.
 *
 * `maxAge`: the plugin's default is 5 seconds, so any call after a short idle
 * paid a preflight round trip again. 7200 is the longest Chromium honours.
 *
 * `exposeHeaders`: the plugin's default echoes every REQUEST header name back,
 * `cf-connecting-ip` and `x-forwarded-for` among them. No browser client reads
 * a response header beyond the ones always exposed, so none is listed.
 */
export function buildCorsOptions(frontendUrl: string, options: BrowserOriginOptions) {
  return {
    origin: buildCorsOrigins(frontendUrl, options),
    credentials: true,
    allowedHeaders: ['Authorization', 'Content-Type', LANGUAGE_HEADER, TURNSTILE_HEADER],
    maxAge: 7200,
    exposeHeaders: [] as string[],
  };
}

/** `trustedOrigins` value for Better-Auth. */
export function buildTrustedOrigins(
  frontendUrl: string,
  { isProduction, extraOrigins }: BrowserOriginOptions
): string[] {
  const exact = exactOrigins(frontendUrl, extraOrigins);
  return isProduction ? exact : [...exact, ...LOOPBACK_TRUSTED_ORIGIN_PATTERNS];
}

/**
 * Whether a WebSocket handshake came from a page allowed to use the api
 * (SC-1351). The same set CORS allows. A missing Origin is not a browser, so
 * it cannot be carrying a victim's cookie and is left to the session check.
 */
export function isAllowedWebSocketOrigin(
  origin: string | undefined,
  frontendUrl: string,
  options: BrowserOriginOptions
): boolean {
  if (!origin) return true;
  return buildCorsOrigins(frontendUrl, options).some((allowed) =>
    typeof allowed === 'string' ? allowed === origin : allowed.test(origin)
  );
}
