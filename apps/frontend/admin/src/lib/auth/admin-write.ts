import { getPasskeyConfig } from '@/lib/auth/config';
import { SESSION_COOKIE, type SessionPayload, verifySession } from '@/lib/auth/session';
import { invalidateCache } from '@/lib/cache';
import { appendAudit } from '@/lib/clients/auditLog';
import { getEnv } from '@/lib/env';

/**
 * Shared session-resolution + actor-derivation for `/api/admin/*` write
 * proxies. Middleware already gates every non-auth route behind the
 * passkey session cookie; the proxies re-verify here as defense in
 * depth (so a misconfigured matcher can't accidentally expose a write
 * endpoint).
 *
 * `actor` is `passkey:<credShort>:<sessionIat>` — credentialId alone
 * doesn't distinguish sessions because the admin app uses a single
 * shared passkey, so we append `iat` to identify a specific login.
 */

export interface AdminCaller {
  session: SessionPayload;
  actor: string;
}

function cookieHeaderValue(headerValue: string | null, name: string): string | undefined {
  if (!headerValue) return undefined;
  for (const raw of headerValue.split(';')) {
    const [k, ...rest] = raw.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
}

export async function resolveAdminCaller(request: Request): Promise<AdminCaller | null> {
  const cookieValue = cookieHeaderValue(request.headers.get('cookie'), SESSION_COOKIE);
  if (!cookieValue) return null;
  const session = await verifySession(cookieValue);
  if (!session) return null;

  let actor = 'admin-app';
  try {
    const { credentialIdB64 } = getPasskeyConfig();
    actor = `passkey:${credentialIdB64.slice(0, 12)}:${session.iat}`;
  } catch {
    // Config missing — fall back to the app-level identifier.
  }

  return { session, actor };
}

export async function sha256Hex(data: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(data));
  return bytesToHex(new Uint8Array(digest));
}

export async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return bytesToHex(new Uint8Array(sig));
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

interface ProxyToBackendArgs {
  /** Resolved admin caller — pass the result of `resolveAdminCaller`. */
  caller: AdminCaller;
  /** Dot-separated audit-log action key (e.g. `dlq.replay`). */
  action: string;
  /** Short target identifier for the audit row. */
  target?: string;
  /** Backend HTTP method. */
  method: 'POST' | 'DELETE' | 'PUT';
  /** Backend path (must include leading `/`). */
  path: string;
  /** Optional JSON body. Pass `undefined` for empty-body requests. */
  body?: Record<string, unknown>;
  /** Cache keys to drop from Upstash on a successful response. */
  invalidate?: string[];
}

/**
 * Forward a request to the backend with HMAC + actor headers identical
 * to the existing BullMQ retry/remove flow. Handles the audit-log write
 * + cache invalidation + body-hash math so individual route handlers
 * stay tiny.
 *
 * Callers must have already run `writesEnabled()` gating; we trust the
 * caller didn't reach this helper otherwise (keeps the gate logic next
 * to the route definition where it can also short-circuit before
 * parsing the body).
 */
export async function proxyToBackend({
  caller,
  action,
  target,
  method,
  path,
  body,
  invalidate,
}: ProxyToBackendArgs): Promise<Response> {
  const secret = getEnv('ADMIN_JOBS_HMAC_SECRET');
  const backendUrl = getEnv('BACKEND_BASE_URL') ?? 'https://api.scani.xyz';
  if (!secret) {
    return Response.json({ error: 'server misconfigured: no admin HMAC secret' }, { status: 503 });
  }

  const bodyText = body ? JSON.stringify(body) : '';
  const bodyHash = await sha256Hex(bodyText);
  const timestamp = String(Date.now());
  const canonical = `${method}\n${path}\n${timestamp}\n${caller.actor}\n${bodyHash}`;
  const hmacHex = await hmacSha256Hex(secret, canonical);

  const headers: Record<string, string> = {
    'x-admin-hmac': hmacHex,
    'x-admin-timestamp': timestamp,
    'x-admin-actor': caller.actor,
  };
  if (body) headers['content-type'] = 'application/json';

  const res = await fetch(`${backendUrl}${path}`, {
    method,
    headers,
    body: body ? bodyText : undefined,
    cache: 'no-store',
  });

  await appendAudit({
    actor: caller.actor,
    action,
    target,
    outcome: res.ok ? 'ok' : 'error',
    detail: res.ok ? undefined : `backend returned ${res.status}`,
  });

  if (res.ok && invalidate?.length) {
    await Promise.all(invalidate.map((k) => invalidateCache(k)));
  }

  const responseBody = await res.text();
  return new Response(responseBody, {
    status: res.status,
    headers: {
      'content-type': res.headers.get('content-type') ?? 'application/json',
    },
  });
}
