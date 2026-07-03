/**
 * Read-only pipeline against the queue/rate-limiter Redis, proxied
 * through the backend's HMAC-gated `/admin/jobs/redis-read` endpoint.
 *
 * That Redis is embedded in the scani-worker Fly machine and reachable
 * over 6PN private networking only (it replaced the metered Upstash
 * database, whose idle BullMQ polling billed ~$40/mo), so this app —
 * on Cloudflare Pages — can't reach it directly. The backend whitelists
 * commands (read-only) and key prefixes (`bull:*`, `rl:*`); anything
 * else is rejected with 400.
 *
 * Durable admin data (spend overrides, audit log, page cache) stays on
 * Upstash REST — see ./upstash.ts.
 */

import { hmacSha256Hex, sha256Hex } from '../auth/admin-write';
import { getEnv } from '../env';

export async function redisPipeline(commands: Array<Array<string | number>>): Promise<unknown[]> {
  const secret = getEnv('JOBS_HMAC_SECRET');
  const backendUrl = getEnv('BACKEND_BASE_URL') ?? 'https://api.scani.xyz';
  if (!secret) throw new Error('JOBS_HMAC_SECRET missing — cannot query queue Redis');

  const path = '/admin/jobs/redis-read';
  const bodyText = JSON.stringify({ commands });
  const timestamp = String(Date.now());
  // Reads aren't attributed to a passkey session: they run during page
  // render where no per-request actor is in scope, and the backend
  // audits writes only. The constant satisfies the signature contract.
  const actor = 'admin-app:queue-read';
  const canonical = `POST\n${path}\n${timestamp}\n${actor}\n${await sha256Hex(bodyText)}`;
  const hmacHex = await hmacSha256Hex(secret, canonical);

  const res = await fetch(`${backendUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-admin-hmac': hmacHex,
      'x-admin-timestamp': timestamp,
      'x-admin-actor': actor,
    },
    body: bodyText,
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`redis-read proxy returned ${res.status}`);
  const parsed = (await res.json()) as { results?: unknown[] };
  if (!Array.isArray(parsed.results)) throw new Error('redis-read proxy returned no results');
  return parsed.results;
}
