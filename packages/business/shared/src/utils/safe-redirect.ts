/**
 * Validate a redirect target derived from an unauthenticated source
 * (e.g. a `?returnTo=` / `?next=` URL parameter) and return it only if
 * it points to a safe same-origin path. Otherwise return `fallback`.
 *
 * The threat we're defending against is the open-redirect leg of a
 * phishing chain: an attacker links the user to
 * `/auth?returnTo=https://attacker.com/`, the user signs in, and the
 * SPA happily redirects them off-site. We can't compare against an
 * absolute origin in plain client code (the SPA may run on multiple
 * hostnames in dev / preview / prod), so the contract here is simpler:
 * accept only paths that are *unambiguously* same-origin.
 *
 * Safe shapes:
 *   `/`                       — root path
 *   `/dashboard`              — sub-path
 *   `/dashboard?tab=summary`  — with query
 *   `/dashboard#section-2`    — with hash
 *
 * Rejected:
 *   `https://anything`        — absolute URL (might match own origin
 *                               but easier to reject than to keep an
 *                               allow-list in sync)
 *   `//evil.com`              — protocol-relative — browsers route this
 *                               cross-origin
 *   `\\evil.com`              — same trick via Windows-style separator
 *   `javascript:alert(1)`     — script execution
 *   `data:…` / `blob:…`       — opaque schemes
 *   `'  /dashboard'`          — leading whitespace can flip behaviour
 *                               in some hosts (`new URL` strips it,
 *                               `location.assign` may not)
 *   anything not starting `/`
 */
export function safeRedirectPath(input: string | null | undefined, fallback: string): string {
  if (typeof input !== 'string') return fallback;
  // Reject leading whitespace / control bytes — browsers handle them
  // inconsistently and they're never present in legitimate links.
  if (input.length === 0 || input !== input.trim()) return fallback;
  if (!input.startsWith('/')) return fallback;
  // Protocol-relative: //attacker.com or //attacker.com/path. Either
  // form makes the browser navigate cross-origin.
  if (input.startsWith('//')) return fallback;
  // Some browsers historically treated `/\` as a path separator pair
  // and drove off-origin. Cheap to reject.
  if (input.startsWith('/\\')) return fallback;
  return input;
}
