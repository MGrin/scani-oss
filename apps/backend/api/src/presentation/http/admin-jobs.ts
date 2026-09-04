/**
 * HMAC-gated admin endpoints for BullMQ job management.
 *
 * The admin app (Cloudflare Pages, passkey-gated) proxies retry/remove
 * requests here so that BullMQ's own state machine — `job.retry()` /
 * `job.remove()` — stays authoritative. We deliberately do NOT expose raw
 * writes against the queue's storage from the admin app: BullMQ transitions
 * a job between states through its own commands, and recomputing that by
 * hand is fragile whichever backend is underneath.
 *
 * `POST /admin/jobs/redis-read` lives here for history and is NOT a queue
 * endpoint. The queue is on the Postgres backend (`createPostgresBackend`,
 * `@scani/queue`) and the admin reads it straight out of `bullmq.job`; SC-518
 * took `bull:` off the whitelist below, so a queue key is now rejected 400.
 * What the proxy still carries is the rate limiter's `rl:*` windows, which
 * are on the worker-embedded Redis, reachable over Fly 6PN only — see
 * validateRedisReadCommands and REDIS_READ_KEY_PREFIXES.
 *
 * Auth + replay protection + the tamper-evident audit writer live in
 * ./admin-common (shared with admin-data).
 */

import { QueueClient } from '@scani/queue';
import type { Redis } from 'ioredis';
import { Container } from 'typedi';
import { audit, createAdminGate } from './admin-common';

const getQueue = () => Container.get(QueueClient).get();

// Read-only Redis commands the admin dashboard may run through
// /admin/jobs/redis-read, each with the key at argv[1]. The queue +
// rate-limiter Redis moved off Upstash onto the worker-embedded Redis
// (6PN-only), so the admin app — on Cloudflare Pages, outside the Fly
// private network — inspects rate-limiter windows (`rl:*`) through this
// proxy instead of Upstash REST. Queue state used to come through here too
// (`bull:*`); since SC-518 it is read straight from Postgres.
const REDIS_READ_COMMANDS = new Set([
  'LLEN',
  'LRANGE',
  'LPOS',
  'ZCARD',
  'ZRANGE',
  'ZSCORE',
  'HGETALL',
]);
// SC-518 narrowed this from ['bull:', 'rl:'] to ['rl:'].
//
// Queue state moved to Postgres, and the admin reads it there directly through
// the same `getSql()` it already uses for every other stats module — so the
// `bull:` prefix no longer needs to be reachable through a shared-HMAC
// endpoint. What remains is the rate limiter's `rl:*` windows, which are still
// on Redis (6PN-only, so unreachable from Cloudflare Pages) and still need the
// proxy.
//
// The whitelist below is NOT dead and must not be deleted: it is still the
// entire boundary for those reads. It is removable only when the rate limiter
// moves too, at which point the whole endpoint goes.
const REDIS_READ_KEY_PREFIXES = ['rl:'];
const REDIS_READ_MAX_COMMANDS = 256;

export type RedisReadValidation =
  | { ok: true; commands: Array<Array<string | number>> }
  | { ok: false; reason: string };

/**
 * Validate an untrusted pipeline payload down to read-only commands on
 * queue keys. Exported for tests — this whitelist is the entire
 * security boundary that keeps the shared-HMAC caller away from
 * KEYS/FLUSHALL/GET on non-queue data.
 */
export function validateRedisReadCommands(input: unknown): RedisReadValidation {
  if (!Array.isArray(input)) return { ok: false, reason: 'commands must be an array' };
  if (input.length === 0) return { ok: false, reason: 'empty pipeline' };
  if (input.length > REDIS_READ_MAX_COMMANDS) {
    return { ok: false, reason: `pipeline exceeds ${REDIS_READ_MAX_COMMANDS} commands` };
  }
  const commands: Array<Array<string | number>> = [];
  for (const entry of input) {
    if (!Array.isArray(entry) || entry.length < 2) {
      return { ok: false, reason: 'each command must be [name, key, ...args]' };
    }
    const [name, key, ...args] = entry;
    if (typeof name !== 'string' || !REDIS_READ_COMMANDS.has(name.toUpperCase())) {
      return { ok: false, reason: `command not allowed: ${String(name)}` };
    }
    if (typeof key !== 'string' || !REDIS_READ_KEY_PREFIXES.some((p) => key.startsWith(p))) {
      return {
        ok: false,
        reason: `key must start with one of: ${REDIS_READ_KEY_PREFIXES.join(', ')}`,
      };
    }
    for (const arg of args) {
      if (typeof arg !== 'string' && typeof arg !== 'number') {
        return { ok: false, reason: 'command args must be strings or numbers' };
      }
    }
    commands.push([name.toUpperCase(), key, ...(args as Array<string | number>)]);
  }
  return { ok: true, commands };
}

// biome-ignore lint/suspicious/noExplicitAny: Elysia accumulates route types; match whatever shape the caller has.
export function registerAdminJobsRoutes(app: any, redis?: Redis | null): void {
  const { secret, authenticate, authFailureBody } = createAdminGate('admin-jobs', redis);

  app
    // biome-ignore lint/suspicious/noExplicitAny: Elysia handler ctx types are dynamic
    .post('/admin/jobs/redis-read', async ({ request, set }: any) => {
      const actor = await authenticate(request, 'POST', set);
      if (!actor) return authFailureBody(set.status);
      if (!redis) {
        set.status = 503;
        return { error: 'queue redis unavailable' };
      }
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(await request.clone().text());
      } catch {
        set.status = 400;
        return { error: 'body must be JSON' };
      }
      const validated = validateRedisReadCommands((parsedBody as { commands?: unknown })?.commands);
      if (!validated.ok) {
        set.status = 400;
        return { error: validated.reason };
      }
      try {
        const executed = await redis.pipeline(validated.commands).exec();
        // ioredis exec() yields [error, result] pairs; surface per-command
        // failures as null so one bad key can't fail the whole dashboard.
        const results = (executed ?? []).map(([err, result]) => (err ? null : result));
        return { results };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set.status = 500;
        return { error: msg };
      }
    })
    // biome-ignore lint/suspicious/noExplicitAny: Elysia handler ctx types are dynamic
    .post('/admin/jobs/:id/retry', async ({ params, request, set }: any) => {
      const actor = await authenticate(request, 'POST', set);
      if (!actor) return authFailureBody(set.status);

      try {
        const queue = getQueue();
        const job = await queue.getJob(params.id);
        if (!job) {
          await audit(actor, 'job.retry', params.id, 'failure', { reason: 'not_found' }, secret);
          set.status = 404;
          return { error: 'job not found' };
        }
        // Same reset as the user-facing retry (SC-167): without it the job
        // comes back with its budget already spent and gets exactly one
        // attempt, while `attempts_made` climbs past `attempts_allowed`.
        await job.retry('failed', { resetAttemptsMade: true });
        await audit(actor, 'job.retry', params.id, 'success', { name: job.name }, secret);
        return { ok: true, jobId: params.id };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await audit(actor, 'job.retry', params.id, 'failure', { error: msg }, secret);
        set.status = 500;
        return { error: msg };
      }
    })
    // biome-ignore lint/suspicious/noExplicitAny: Elysia handler ctx types are dynamic
    .delete('/admin/jobs/:id', async ({ params, request, set }: any) => {
      const actor = await authenticate(request, 'DELETE', set);
      if (!actor) return authFailureBody(set.status);

      try {
        const queue = getQueue();
        const job = await queue.getJob(params.id);
        if (!job) {
          await audit(actor, 'job.remove', params.id, 'failure', { reason: 'not_found' }, secret);
          set.status = 404;
          return { error: 'job not found' };
        }
        await job.remove();
        await audit(actor, 'job.remove', params.id, 'success', { name: job.name }, secret);
        return { ok: true, jobId: params.id };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await audit(actor, 'job.remove', params.id, 'failure', { error: msg }, secret);
        set.status = 500;
        return { error: msg };
      }
    });
}
