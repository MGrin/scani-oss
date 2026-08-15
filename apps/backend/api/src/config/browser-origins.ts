/**
 * Browser origins the api answers to.
 *
 * Production accepts exactly one origin — `FRONTEND_URL` — and nothing else.
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
}

/** `origin` value for `@elysiajs/cors`. */
export function buildCorsOrigins(
  frontendUrl: string,
  { isProduction }: BrowserOriginOptions
): (string | RegExp)[] {
  return isProduction ? [frontendUrl] : [frontendUrl, LOOPBACK_ORIGIN];
}

/** `trustedOrigins` value for Better-Auth. */
export function buildTrustedOrigins(
  frontendUrl: string,
  { isProduction }: BrowserOriginOptions
): string[] {
  return isProduction ? [frontendUrl] : [frontendUrl, ...LOOPBACK_TRUSTED_ORIGIN_PATTERNS];
}
