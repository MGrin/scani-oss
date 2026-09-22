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

export const EDGE_HEADER = 'x-scani-edge';

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
 * through. Only a request that reached Fly's PUBLIC proxy is judged — Fly adds
 * `fly-client-ip` there and nowhere else — so health checks and
 * private-network callers are never refused.
 */
export function edgeLockRefusal(
  req: Request,
  config: RateLimiterConfig = loadRateLimiterConfig()
): Response | null {
  if (config.SCANI_EDGE_LOCK !== 'enforce') return null;
  if (!req.headers.get('fly-client-ip')) return null;
  if (isHealthPath(new URL(req.url).pathname)) return null;
  if (cameThroughEdge(req, config)) return null;
  return new Response(JSON.stringify({ error: 'Forbidden' }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });
}
