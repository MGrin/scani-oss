/**
 * Whether a request came through Cloudflare, for an api Cloudflare proxies
 * (SC-1264).
 *
 * Cloudflare adds `x-scani-edge: <SCANI_EDGE_SECRET>` on the way in. A request
 * carrying it came through Cloudflare, so its `cf-connecting-ip` is Cloudflare's
 * reading and can be trusted. One without it came straight to `*.fly.dev`.
 */

import { timingSafeEqual } from 'node:crypto';
import { loadRateLimiterConfig, type RateLimiterConfig } from './config';

const EDGE_HEADER = 'x-scani-edge';

/**
 * Off Fly, the reverse proxy in front of an app sets this on its public
 * listener and overwrites any copy a client sent (SC-1496). Its private
 * listener does not.
 */
const PUBLIC_INGRESS_HEADER = 'x-scani-public-ingress';

/**
 * Whether a request came in from the internet: Fly's public proxy sets
 * `fly-client-ip`, our own proxy sets `PUBLIC_INGRESS_HEADER`. Either header
 * only ever makes a request judged, so a client sending one gains nothing.
 * Their ABSENCE proves a private caller only where something guarantees to set
 * one: on Fly, or with `SCANI_INGRESS_MARKED=on`.
 */
export function reachedPublicIngress(req: Request): boolean {
  return req.headers.has('fly-client-ip') || req.headers.has(PUBLIC_INGRESS_HEADER);
}

export function ingressIsMarked(config: RateLimiterConfig = loadRateLimiterConfig()): boolean {
  return Boolean(config.FLY_APP_NAME) || config.SCANI_INGRESS_MARKED === 'on';
}

export function cameThroughEdge(
  req: Request,
  config: RateLimiterConfig = loadRateLimiterConfig()
): boolean {
  const secret = config.SCANI_EDGE_SECRET;
  const presented = req.headers.get(EDGE_HEADER);
  if (!secret || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isHealthPath(pathname: string): boolean {
  return pathname === '/health' || pathname.startsWith('/health/') || pathname === '/ready';
}

/**
 * The refusal for a request that bypassed Cloudflare, or null to let it
 * through. Only a request that reached a public ingress is judged, so health
 * checks and private-network callers are never refused.
 */
export function edgeLockRefusal(
  req: Request,
  config: RateLimiterConfig = loadRateLimiterConfig()
): Response | null {
  if (config.SCANI_EDGE_LOCK !== 'enforce') return null;
  if (!reachedPublicIngress(req)) return null;
  if (isHealthPath(new URL(req.url).pathname)) return null;
  if (cameThroughEdge(req, config)) return null;
  return new Response(JSON.stringify({ error: 'Forbidden' }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });
}
