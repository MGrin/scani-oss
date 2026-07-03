/**
 * HMAC-gated admin endpoints for BullMQ job management.
 *
 * The admin app (Cloudflare Pages, passkey-gated) proxies retry/remove
 * requests here so that BullMQ's own state machine — `job.retry()` /
 * `job.remove()` — stays authoritative. We deliberately do NOT expose raw
 * Redis writes from the admin app, because BullMQ uses Lua scripts to
 * transition jobs between sets and recomputing that manually is fragile.
 *
 * Queue *reads* also proxy through here (`POST /admin/jobs/redis-read`):
 * the queue Redis is embedded in the scani-worker machine and reachable
 * over Fly 6PN only, so the admin app can't inspect it directly the way
 * it could Upstash REST. The endpoint accepts a pipeline of whitelisted
 * read-only commands on `bull:*` keys — see validateRedisReadCommands.
 *
 * Auth: a shared HMAC secret (`JOBS_HMAC_SECRET`) is the only
 * trust anchor. Admin signs
 *   `${method}\n${path}\n${timestamp}\n${actor}\n${sha256Hex(rawBody)}`
 * with HMAC-SHA256 and sends the hex digest in `x-admin-hmac`. Binding
 * `actor` into the signature prevents a caller who knows the secret from
 * forging someone else's identity in the audit log; hashing the raw body
 * sidesteps Elysia's body parsing (`JSON.stringify` after parse is not
 * guaranteed to match what the admin actually signed — key order and
 * whitespace can drift across runtimes).
 *
 * Backend rejects requests older than 30s or with a bad signature.
 *
 * Audit: every attempt (success or failure) writes a row to
 * `admin_audit_log` so there's a forensic trail beyond application logs.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { db } from '@scani/db/connection';
import { adminAuditLog } from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { QueueClient } from '@scani/queue';
import { desc } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { Container } from 'typedi';
import { loadEnv } from '../../config/env';

const getQueue = () => Container.get(QueueClient).get();

const logger = createComponentLogger('admin-jobs');

const MAX_SKEW_MS = 5_000;
// Replay window: any (signature) seen inside this many ms is rejected
// as a replay. Chosen as a safe multiple of MAX_SKEW_MS so a request
// whose clock drifts to the far edge of the skew window still gets
// covered. Set in Redis as a SET-NX with PX expiry; the same signature
// presented twice fails the SET-NX and is rejected.
const NONCE_TTL_MS = MAX_SKEW_MS * 4;
const EMPTY_BODY_SHA256 = createHash('sha256').update('').digest('hex');

// Per-process fallback when no Redis client was passed at registration.
// Tests + local dev without Redis: a Map keyed by signature, swept on
// every check. Production passes a real Redis client.
class InMemoryNonceStore {
  private readonly seen = new Map<string, number>();

  async addOrReject(key: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    // Sweep expired entries so the map doesn't grow unbounded under load.
    for (const [k, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(k);
    }
    if (this.seen.has(key)) return false;
    this.seen.set(key, now + ttlMs);
    return true;
  }
}

interface NonceStore {
  addOrReject(key: string, ttlMs: number): Promise<boolean>;
}

class RedisNonceStore implements NonceStore {
  constructor(private readonly redis: Redis) {}

  async addOrReject(key: string, ttlMs: number): Promise<boolean> {
    // `SET key 1 PX ttl NX` — returns 'OK' if newly set, null if the
    // key already existed. Atomic across replicas.
    const res = await this.redis.set(`admin:nonce:${key}`, '1', 'PX', ttlMs, 'NX');
    return res === 'OK';
  }
}

function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function verifyHmac(
  secret: string,
  headers: Record<string, string | undefined>,
  method: string,
  path: string,
  bodyHashHex: string
): { ok: true; actor: string } | { ok: false; reason: string } {
  const hmac = headers['x-admin-hmac'];
  const timestamp = headers['x-admin-timestamp'];
  const actor = headers['x-admin-actor'];
  if (!hmac || !timestamp) {
    return { ok: false, reason: 'missing hmac headers' };
  }
  if (!actor || actor.length === 0) {
    return { ok: false, reason: 'missing actor' };
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad timestamp' };
  const skew = Math.abs(Date.now() - ts);
  if (skew > MAX_SKEW_MS) return { ok: false, reason: `skew ${skew}ms exceeds ${MAX_SKEW_MS}ms` };

  const canonical = `${method}\n${path}\n${timestamp}\n${actor}\n${bodyHashHex}`;
  const expected = createHmac('sha256', secret).update(canonical).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(hmac, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true, actor };
}

// Cap audit-log detail payloads so a misbehaving caller can't inflate
// the jsonb column (every retry/remove tries to log; an OOM here would
// take down /jobs admin entirely). Strings are truncated, nested
// objects are stringified-and-truncated, everything else passes
// through. Single-level walk only — deeper hostile payloads are
// flattened rather than fully sanitised.
const AUDIT_DETAIL_MAX_KEYS = 20;
const AUDIT_DETAIL_VALUE_MAX_CHARS = 1024;

function sanitizeAuditDetails(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let keys = 0;
  for (const [k, v] of Object.entries(input)) {
    if (keys >= AUDIT_DETAIL_MAX_KEYS) break;
    if (v == null) {
      out[k] = v;
    } else if (typeof v === 'string') {
      out[k] =
        v.length > AUDIT_DETAIL_VALUE_MAX_CHARS
          ? v.slice(0, AUDIT_DETAIL_VALUE_MAX_CHARS) + '…'
          : v;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else {
      const stringified = JSON.stringify(v);
      out[k] =
        stringified.length > AUDIT_DETAIL_VALUE_MAX_CHARS
          ? stringified.slice(0, AUDIT_DETAIL_VALUE_MAX_CHARS) + '…'
          : stringified;
    }
    keys++;
  }
  return out;
}

// Canonical serialization for the HMAC chain. Order is fixed and
// independent of insertion order so a verifier can recompute the
// signature without seeing the schema. JSON.stringify of `details` is
// already canonicalized by sanitizeAuditDetails (it walks keys in
// insertion order); we accept that as the "as-stored" payload.
function canonicalAuditPayload(row: {
  actor: string;
  action: string;
  resource: string;
  result: string;
  details: Record<string, unknown>;
  createdAtIso: string;
  prevSignature: string;
}): string {
  return [
    `actor=${row.actor}`,
    `action=${row.action}`,
    `resource=${row.resource}`,
    `result=${row.result}`,
    `details=${JSON.stringify(row.details)}`,
    `created_at=${row.createdAtIso}`,
    `prev=${row.prevSignature}`,
  ].join('\n');
}

async function audit(
  actor: string,
  action: string,
  resource: string,
  result: 'success' | 'failure',
  details: Record<string, unknown>,
  hmacSecret: string | undefined
): Promise<void> {
  try {
    const sanitized = sanitizeAuditDetails(details);
    // Use the same `created_at` value in both the signature and the
    // INSERT so the canonical payload exactly matches what's stored.
    const createdAt = new Date();
    let prevSignature = '';
    let signature: string | null = null;
    if (hmacSecret) {
      // Fetch the previous row's signature. SELECT … ORDER BY created_at
      // DESC LIMIT 1 — the table has an index on created_at so this is
      // cheap. Race: two concurrent writers might both read the same
      // prev row and produce sibling rows that share `prev_signature`.
      // That's still detectable by the verifier (the chain forks) but
      // would make a clean linear chain harder to rebuild. The admin
      // surface is single-actor in practice (one operator triggers
      // retry/remove from the dashboard), so concurrent writes are
      // rare; if that changes, switch this to a SERIALIZABLE
      // transaction or use a Postgres advisory lock keyed on the
      // table name.
      const [prev] = await db
        .select({ signature: adminAuditLog.signature })
        .from(adminAuditLog)
        .orderBy(desc(adminAuditLog.createdAt))
        .limit(1);
      prevSignature = prev?.signature ?? '';
      signature = createHmac('sha256', hmacSecret)
        .update(
          canonicalAuditPayload({
            actor,
            action,
            resource,
            result,
            details: sanitized,
            createdAtIso: createdAt.toISOString(),
            prevSignature,
          })
        )
        .digest('hex');
    }
    await db.insert(adminAuditLog).values({
      actor,
      action,
      resource,
      result,
      details: sanitized,
      createdAt,
      prevSignature: hmacSecret ? prevSignature : null,
      signature,
    });
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err), actor, action, resource },
      'Failed to write admin audit log row — continuing'
    );
  }
}

/**
 * Read the raw request body as text, defending against Elysia's body
 * parsing. `request.clone()` preserves the original byte stream so we
 * can hash exactly what the admin signed. If the body has already been
 * consumed (empty GET/DELETE), `text()` returns an empty string and the
 * hash matches `EMPTY_BODY_SHA256`.
 */
async function rawBodyHash(request: Request): Promise<string> {
  try {
    const raw = await request.clone().text();
    if (raw.length === 0) return EMPTY_BODY_SHA256;
    return sha256Hex(raw);
  } catch {
    return EMPTY_BODY_SHA256;
  }
}

// Read-only Redis commands the admin dashboard may run through
// /admin/jobs/redis-read, each with the key at argv[1]. The queue +
// rate-limiter Redis moved off Upstash onto the worker-embedded Redis
// (6PN-only), so the admin app — on Cloudflare Pages, outside the Fly
// private network — inspects queue state (`bull:*`) and rate-limiter
// windows (`rl:*`) through this proxy instead of Upstash REST.
const REDIS_READ_COMMANDS = new Set([
  'LLEN',
  'LRANGE',
  'LPOS',
  'ZCARD',
  'ZRANGE',
  'ZSCORE',
  'HGETALL',
]);
const REDIS_READ_KEY_PREFIXES = ['bull:', 'rl:'];
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
  // Read via the validated env schema instead of `process.env` directly,
  // so the var is checked at boot time (loadEnv exits the process when
  // JOBS_HMAC_SECRET is missing in prod) and not silently per-call.
  const secret = loadEnv().JOBS_HMAC_SECRET;
  if (!secret) {
    logger.warn({}, '⚠️ JOBS_HMAC_SECRET is not set — admin job endpoints will refuse all requests');
  }

  // Replay-protection nonce store. Redis-backed in prod (atomic across
  // backend replicas); in-memory fallback covers tests + local dev. The
  // store records each (HMAC signature) we've seen for NONCE_TTL_MS and
  // rejects the second presentation, closing the 30s replay window
  // that the timestamp-skew check alone left open.
  const nonceStore: NonceStore = redis
    ? new RedisNonceStore(redis)
    : (() => {
        logger.warn(
          {},
          'admin-jobs nonce store falling back to in-memory — replay protection is per-instance only'
        );
        return new InMemoryNonceStore();
      })();

  // Shared HMAC + replay gate for every /admin/jobs/* route. Returns the
  // verified actor, or null after setting the response status. The
  // signature hex digest uniquely identifies a (method, path, timestamp,
  // actor, bodyHash) tuple; a second presentation inside NONCE_TTL_MS is
  // refused as a replay.
  // biome-ignore lint/suspicious/noExplicitAny: Elysia `set` is dynamic
  async function authenticate(request: Request, method: string, set: any): Promise<string | null> {
    const pathname = new URL(request.url).pathname;
    if (!secret) {
      set.status = 503;
      return null;
    }
    const headers: Record<string, string | undefined> = {
      'x-admin-hmac': request.headers.get('x-admin-hmac') ?? undefined,
      'x-admin-timestamp': request.headers.get('x-admin-timestamp') ?? undefined,
      'x-admin-actor': request.headers.get('x-admin-actor') ?? undefined,
    };
    const bodyHash = await rawBodyHash(request);
    const v = verifyHmac(secret, headers, method, pathname, bodyHash);
    if (!v.ok) {
      logger.warn({ reason: v.reason, path: pathname }, 'HMAC verification failed');
      set.status = 401;
      return null;
    }
    const hmacHeader = request.headers.get('x-admin-hmac') ?? '';
    const fresh = await nonceStore.addOrReject(hmacHeader, NONCE_TTL_MS);
    if (!fresh) {
      logger.warn({ path: pathname }, 'admin-jobs replay detected — refusing');
      set.status = 401;
      return null;
    }
    return v.actor;
  }

  const authFailureBody = (status: number) =>
    status === 503 ? { error: 'admin endpoints unavailable' } : { error: 'unauthorized' };

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
        await job.retry();
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
