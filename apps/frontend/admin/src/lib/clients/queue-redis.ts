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
 */

import { signedAdminJson } from './backend-admin';

export async function redisPipeline(commands: Array<Array<string | number>>): Promise<unknown[]> {
  const parsed = await signedAdminJson<{ results?: unknown[] }>('POST', '/admin/jobs/redis-read', {
    body: { commands },
  });
  if (!Array.isArray(parsed.results)) throw new Error('redis-read proxy returned no results');
  return parsed.results;
}
