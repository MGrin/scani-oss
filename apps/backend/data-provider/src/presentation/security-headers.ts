const DOCS_CSP = [
  "default-src 'self'",
  "frame-ancestors 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
  "font-src 'self' data: https://cdn.jsdelivr.net https://fonts.gstatic.com https://fonts.scalar.com",
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
