/**
 * Shared plumbing for the HMAC-gated `/admin/*` endpoints (admin-jobs,
 * admin-data): signature verification, replay protection, and the
 * tamper-evident audit-log writer.
 *
 * Auth model: a shared HMAC secret (`JOBS_HMAC_SECRET`) is the only
 * trust anchor. The admin app (Cloudflare Pages, passkey-gated) signs
 *   `${method}\n${path}\n${timestamp}\n${actor}\n${sha256Hex(rawBody)}`
 * with HMAC-SHA256 and sends the hex digest in `x-admin-hmac`. Binding
 * `actor` into the signature prevents a caller who knows the secret from
 * forging someone else's identity in the audit log; hashing the raw body
 * sidesteps Elysia's body parsing (`JSON.stringify` after parse is not
 * guaranteed to match what the admin actually signed — key order and
 * whitespace can drift across runtimes).
 *
 * The gate rejects requests older than MAX_SKEW_MS or with a bad
 * signature, and refuses any signature it has already accepted inside
 * NONCE_TTL_MS (replay).
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { db } from '@scani/db/connection';
import { adminAuditLog } from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { desc } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { loadEnv } from '../../config/env';

const logger = createComponentLogger('admin-common');

const MAX_SKEW_MS = 5_000;
// Replay window: any (signature) seen inside this many ms is rejected
// as a replay. Chosen as a safe multiple of MAX_SKEW_MS so a request
// whose clock drifts to the far edge of the skew window still gets
// covered. Set in Redis as a SET-NX with PX expiry; the same signature
// presented twice fails the SET-NX and is rejected.
const NONCE_TTL_MS = MAX_SKEW_MS * 4;
const EMPTY_BODY_SHA256 = createHash('sha256').update('').digest('hex');

/**
 * Returned by `parseAdminRawBody` when the signed bytes are gone. A
 * unique symbol rather than a string or a shape: a caller cannot send
 * one as a request body, so it can never be forged into a refusal.
 */
export const ADMIN_BODY_UNREADABLE = Symbol('admin.rawBody.unreadable');

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

/**
 * Handed to a route as its own `parse` hook so the gate and the handler
 * read ONE set of bytes, read once, and it is the same set the admin
 * signed.
 *
 * Elysia parses the body before a route function runs, and it does that
 * on EVERY route here rather than only on tRPC's: `@elysiajs/trpc`
 * mounts `onParse({ as: 'global' })`, which turns body parsing on
 * app-wide. By the time an `/admin/*` handler runs the stream is
 * already drained, so `request.clone().text()` throws `Body already
 * used` — measured on elysia 1.4.28 / @elysiajs/trpc 1.1.0 / bun 1.3.14
 * (SC-1032), and pinned by `admin-gate-body.test.ts`, whose control arm
 * is the same route with no global `onParse`, where the clone succeeds.
 *
 * Claiming the parse step is what keeps the bytes: Elysia uses whatever
 * this returns as `ctx.body`, so the route gets the exact raw text and
 * nothing has to re-read the request.
 */
export async function parseAdminRawBody({
  request,
}: {
  request: Request;
}): Promise<string | typeof ADMIN_BODY_UNREADABLE> {
  // Something upstream drained the stream, so the signed bytes are gone
  // and no honest hash can be computed. Say so rather than hashing the
  // empty string — see `bodyHashFor`.
  if (request.bodyUsed) return ADMIN_BODY_UNREADABLE;
  try {
    return await request.text();
  } catch {
    return ADMIN_BODY_UNREADABLE;
  }
}

/**
 * Hash the body a route's `parse` hook produced.
 *
 * The two cases this separates are the whole of SC-1032. A genuinely
 * bodyless GET/DELETE hashes the empty string, which is what the client
 * signs for it. A body that could not be READ is NOT that: hashing the
 * empty string there made every real-body signature fail while an
 * empty-body signature passed, and it silently removed the body from
 * the signature's coverage. It refuses instead.
 */
function bodyHashFor(body: unknown): { ok: true; hex: string } | { ok: false; reason: string } {
  // GET carries no body and Elysia skips the parse hook entirely, so
  // `undefined` here is the bodyless case rather than a failed read.
  if (body === undefined) return { ok: true, hex: EMPTY_BODY_SHA256 };
  if (body === ADMIN_BODY_UNREADABLE) {
    return { ok: false, reason: 'raw body unreadable — cannot verify signature' };
  }
  if (typeof body !== 'string') {
    // Only `parseAdminRawBody` may feed this. Anything else means the
    // route was registered without it and `body` is already parsed, so
    // the original bytes are unrecoverable.
    return { ok: false, reason: 'admin route is missing its raw-body parser' };
  }
  return { ok: true, hex: body.length === 0 ? EMPTY_BODY_SHA256 : sha256Hex(body) };
}

/**
 * The raw text a verified admin request carried, as a string. Safe to
 * call only after `authenticate` returned an actor — that is what rules
 * out every non-string shape.
 */
export function verifiedRawBody(body: unknown): string {
  return typeof body === 'string' ? body : '';
}

export interface AdminGate {
  /** Env-validated `JOBS_HMAC_SECRET` (undefined outside production). */
  secret: string | undefined;
  /**
   * Verify HMAC + replay for one request. Returns the verified actor,
   * or null after setting the response status on `set`.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Elysia `set` is dynamic
  authenticate(request: Request, method: string, set: any, body: unknown): Promise<string | null>;
  authFailureBody(status: number): { error: string };
}

export function createAdminGate(component: string, redis?: Redis | null): AdminGate {
  // Read via the validated env schema instead of `process.env` directly,
  // so the var is checked at boot time (loadEnv exits the process when
  // JOBS_HMAC_SECRET is missing in prod) and not silently per-call.
  const secret = loadEnv().JOBS_HMAC_SECRET;
  if (!secret) {
    logger.warn(
      { component },
      '⚠️ JOBS_HMAC_SECRET is not set — admin endpoints will refuse all requests'
    );
  }

  const nonceStore: NonceStore = redis
    ? new RedisNonceStore(redis)
    : (() => {
        logger.warn(
          { component },
          'admin nonce store falling back to in-memory — replay protection is per-instance only'
        );
        return new InMemoryNonceStore();
      })();

  async function authenticate(
    request: Request,
    method: string,
    // biome-ignore lint/suspicious/noExplicitAny: Elysia `set` is dynamic
    set: any,
    body: unknown
  ): Promise<string | null> {
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
    const bodyHash = bodyHashFor(body);
    if (!bodyHash.ok) {
      logger.error({ reason: bodyHash.reason, path: pathname }, 'admin gate cannot hash body');
      set.status = 500;
      return null;
    }
    const v = verifyHmac(secret, headers, method, pathname, bodyHash.hex);
    if (!v.ok) {
      logger.warn({ reason: v.reason, path: pathname }, 'HMAC verification failed');
      set.status = 401;
      return null;
    }
    const hmacHeader = request.headers.get('x-admin-hmac') ?? '';
    const fresh = await nonceStore.addOrReject(hmacHeader, NONCE_TTL_MS);
    if (!fresh) {
      logger.warn({ path: pathname }, 'admin replay detected — refusing');
      set.status = 401;
      return null;
    }
    return v.actor;
  }

  return {
    secret,
    authenticate,
    authFailureBody: (status: number) => {
      if (status === 503) return { error: 'admin endpoints unavailable' };
      if (status === 500) return { error: 'admin gate could not read the request body' };
      return { error: 'unauthorized' };
    },
  };
}

// Cap audit-log detail payloads so a misbehaving caller can't inflate
// the jsonb column (every write tries to log; an OOM here would take
// down the admin surface entirely). Strings are truncated, nested
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
          ? `${v.slice(0, AUDIT_DETAIL_VALUE_MAX_CHARS)}…`
          : v;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else {
      const stringified = JSON.stringify(v);
      out[k] =
        stringified.length > AUDIT_DETAIL_VALUE_MAX_CHARS
          ? `${stringified.slice(0, AUDIT_DETAIL_VALUE_MAX_CHARS)}…`
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

export async function audit(
  actor: string,
  action: string,
  resource: string,
  result: 'success' | 'failure' | 'denied',
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
      // writes from the dashboard), so concurrent writes are rare; if
      // that changes, switch this to a SERIALIZABLE transaction or use
      // a Postgres advisory lock keyed on the table name.
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
