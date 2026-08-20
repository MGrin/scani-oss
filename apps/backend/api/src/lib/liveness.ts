/**
 * Is this request the liveness probe Fly gates traffic on?
 *
 * `apps/backend/api/fly.toml` configures exactly one check:
 *
 *     [[http_service.checks]]
 *       method = "GET"
 *       path   = "/health"
 *
 * so the answer to this question decides whether a machine stays in the load
 * balancer. Middleware that runs before `/health` is therefore part of the
 * probe whether it looks like it or not — which is how a Redis-backed rate
 * limiter took the api off the internet for 14 minutes on 2026-08-15 while the
 * handler it guarded touched nothing (SC-225).
 *
 * **Exact path, not a prefix.** `/health/deep` and `/health/db` are dependency
 * probes: their whole job is to fail when Redis or the database is unreachable,
 * and `deploy-local.sh` smokes `/health/deep` after every worker deploy. A
 * `startsWith('/health')` here would quietly exempt them too and hand an
 * unauthenticated caller an unmetered path that opens real connections.
 *
 * `/readyz` is deliberately NOT exempt either. It answers "should this machine
 * receive traffic yet", which is a question about dependencies, so it is
 * allowed to be slow and allowed to fail.
 */
const LIVENESS_PATH = '/health';

export function isLivenessProbe(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  return livenessPathname(request.url) === LIVENESS_PATH;
}

/**
 * `new URL` throws on a malformed URL, and this runs in front of every
 * request — a caller must not be able to turn a bad path into a 500 here.
 * An unparseable URL is simply not the probe.
 */
function livenessPathname(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}
