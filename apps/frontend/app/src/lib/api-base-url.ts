/**
 * Where this build talks to its API, resolved once (SC-467).
 *
 * `VITE_API_URL` is baked in at build time and carries two very different
 * kinds of value:
 *
 *   - **Absolute**, for a build that knows its backend's origin —
 *     `http://localhost:3001` in dev, `https://api.scani.xyz` for
 *     `app.scani.xyz`.
 *   - **Relative**, for the published `scani/frontend-app` image, which is
 *     built with `VITE_API_URL=/api` so that ONE artefact serves any hostname.
 *     nginx inside that image reverse-proxies `/api/` to whatever
 *     `API_UPSTREAM` names, and the browser never learns the backend's real
 *     address. That is what lets a self-hoster, `demo.scani.xyz` and a
 *     laptop run the same bytes.
 *
 * `fetch` takes either, so most call sites never noticed the difference.
 * Better-Auth and `new WebSocket()` do not: both want an absolute URL and
 * both fail on `/api`, so this resolves the relative form against the page's
 * own origin before handing it over.
 *
 * ## Why this file exists at all
 *
 * The published image was a **white screen**, and had been since the images
 * were first published (SC-453). `createAuthClient({ baseURL: '/api' })`
 * throws `BetterAuthError: Invalid base URL: /api` during MODULE evaluation —
 * so `main.tsx` never runs, React never mounts, and `#root` stays empty with
 * nothing rendered and nothing in the console except that one line. Measured
 * against the published `scani/frontend-app:0.13.0` image on 2026-08-21, not
 * inferred: `errs: ["Uncaught BetterAuthError: Invalid base URL: /api"],
 * rootChildren: 0`.
 *
 * A module-scope throw is the worst shape this failure could take. It has no
 * error boundary above it, produces no network request to look at, and leaves
 * a page that is indistinguishable from a slow one.
 */

const CONFIGURED = import.meta.env.VITE_API_URL;

/**
 * An absolute API base URL, given whatever the build was handed.
 *
 * Pure, and takes its origin as an argument, so the relative case can be
 * exercised without a browser.
 */
export function resolveApiBaseUrl(configured: string | undefined, origin: string): string {
  const value = configured?.trim();
  if (!value) throw new Error('VITE_API_URL is required');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value.replace(/\/+$/, '');
  // `new URL` handles `/api`, `api/` and `./api` alike, and normalises the
  // result. The trailing-slash strip matches the absolute branch so callers
  // can append `/trpc` without producing a double slash.
  return new URL(value, origin).toString().replace(/\/+$/, '');
}

/**
 * The resolved base, for the app. Evaluated lazily rather than at module load
 * so importing this file cannot be the thing that throws — which is the exact
 * failure it was written to fix.
 */
export function apiBaseUrl(): string {
  return resolveApiBaseUrl(CONFIGURED, globalThis.location?.origin ?? 'http://localhost');
}
