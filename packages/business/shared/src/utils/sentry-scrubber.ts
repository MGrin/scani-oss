/**
 * Sentry `beforeSend` PII scrubber for the Scani frontends.
 *
 * The default Sentry SDK already strips a lot of obvious PII (cookies,
 * password fields), but it doesn't catch: email addresses leaking
 * via error messages or breadcrumbs, JWT-shaped tokens that crept
 * into URLs / strings, or `Authorization` header values dropped by
 * the fetch instrumentation. This scrubber walks every string in
 * the event and rewrites those three categories with `<redacted>`.
 *
 * It's deliberately conservative: false positives just mean a slightly
 * less useful Sentry event; false negatives leak. Plain heuristics —
 * regex matchers — beat any kind of allow-list when the cost of
 * being wrong is asymmetric.
 *
 * Usage:
 *
 *   Sentry.init({
 *     ...,
 *     beforeSend: scrubSentryEvent,
 *     beforeBreadcrumb: scrubSentryBreadcrumb,
 *   });
 */

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// JWT shape: 3 dot-separated base64url segments. The first two are
// header + payload (always non-empty), the third is the signature.
// Base64url alphabet is [A-Za-z0-9_-]; we cap segment length at a
// generous 1024 each to avoid pathological backtracking.
const JWT_RE = /\beyJ[A-Za-z0-9_-]{4,1024}\.[A-Za-z0-9_-]{4,1024}\.[A-Za-z0-9_-]{4,1024}\b/g;
// Bearer / token authorization values. Only the value portion is
// scrubbed — the header name itself is kept so the trace context
// remains useful.
const AUTH_HEADER_RE = /(authorization\s*:\s*(?:bearer|token)\s+)([^\s"'<>]+)/gi;

const REDACTED = '<redacted>';

export function scrubString(input: string): string {
  if (input.length === 0) return input;
  return input
    .replace(JWT_RE, REDACTED)
    .replace(AUTH_HEADER_RE, `$1${REDACTED}`)
    .replace(EMAIL_RE, REDACTED);
}

/**
 * Walk every leaf string in the value and apply `scrubString` in place.
 * Cycles are tracked via a WeakSet so a self-referencing object can't
 * spin the scrubber.
 */
function scrubInPlace(value: unknown, seen: WeakSet<object>): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value !== 'object') return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = scrubInPlace(value[i], seen);
    }
    return value;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    obj[key] = scrubInPlace(obj[key], seen);
  }
  return obj;
}

/**
 * Sentry `beforeSend` callback. Mutates the event in place and
 * returns it. Returns `null` only if `event` itself is null
 * (hands-off semantics — never drop an event for scrubbing reasons).
 */
export function scrubSentryEvent<T>(event: T): T {
  if (event == null) return event;
  scrubInPlace(event, new WeakSet());
  return event;
}

/**
 * Sentry `beforeBreadcrumb` callback. Same scrub, smaller payload.
 */
export function scrubSentryBreadcrumb<T>(breadcrumb: T): T {
  if (breadcrumb == null) return breadcrumb;
  scrubInPlace(breadcrumb, new WeakSet());
  return breadcrumb;
}
