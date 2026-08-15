/**
 * Security headers for every response this service sends.
 *
 * The api app sets the same set; the data-provider serves the same kind of
 * bearer-auth API surface, so the headers match. CSP defaults to
 * `default-src 'none'` because this service returns JSON — no inline scripts,
 * no images. HSTS only ships in production, where TLS is guaranteed.
 *
 * `/docs` is the one exception, twice over: it embeds Scalar's API-reference
 * bundle from jsdelivr, so it needs a CSP that whitelists the CDN and what
 * Scalar fetches at runtime; and it may be framed by its own origin, which is
 * how a console served from the same host can show the reference with a way
 * back (see `docsOpenInApp` in the cloud app — SC-121). It is a static public
 * page with no form and no session-bound control, so same-origin framing costs
 * nothing, and every other path still refuses framing outright.
 */

const DOCS_CSP = [
  "default-src 'self'",
  "frame-ancestors 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
  "font-src 'self' data: https://cdn.jsdelivr.net https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
].join('; ');

const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

export function securityHeaders(pathname: string, isProduction: boolean): Record<string, string> {
  const isDocsPage = pathname === '/docs';
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': isDocsPage ? 'SAMEORIGIN' : 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    'Cross-Origin-Resource-Policy': 'same-site',
    'Content-Security-Policy': isDocsPage ? DOCS_CSP : API_CSP,
    ...(isProduction
      ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload' }
      : {}),
  };
}
