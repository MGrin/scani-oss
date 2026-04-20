/**
 * Admin → backend proxy for HMAC-gated BullMQ write actions.
 *
 * Middleware (`apps/admin/src/middleware.ts`) already gates all non-auth
 * routes behind a valid passkey session, so /api/bullmq/* can only be
 * reached by a logged-in operator. We additionally verify the session
 * cookie here as defense in depth, and sign the outbound backend
 * request with `ADMIN_JOBS_HMAC_SECRET` so a compromised admin deploy
 * still can't mutate the backend without the shared secret.
 *
 * Canonical HMAC string (must match `apps/backend/src/presentation/http/admin-jobs.ts`):
 *   `${method}\n${path}\n${timestamp}\n${actor}\n${sha256Hex(rawBody)}`
 *
 * `actor` is the passkey credential ID plus the session's `iat` so audit
 * rows identify a specific login rather than just "the admin app". It's
 * bound into the signature — a caller with the secret can't forge someone
 * else's identity.
 */

import { getPasskeyConfig } from '@/lib/auth/config';
import { SESSION_COOKIE, verifySession } from '@/lib/auth/session';
import { invalidateCache } from '@/lib/cache';
import { getEnv } from '@/lib/env';

function cookieHeaderValue(headerValue: string | null, name: string): string | undefined {
  if (!headerValue) return undefined;
  const pairs = headerValue.split(';');
  for (const raw of pairs) {
    const [k, ...rest] = raw.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
}

export async function proxyJobAction(
  request: Request,
  action: 'retry' | 'remove'
): Promise<Response> {
  const cookieValue = cookieHeaderValue(request.headers.get('cookie'), SESSION_COOKIE);
  const session = cookieValue ? await verifySession(cookieValue) : null;
  if (!session) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const secret = getEnv('ADMIN_JOBS_HMAC_SECRET');
  const backendUrl = getEnv('BACKEND_BASE_URL') ?? 'https://api.scani.xyz';
  if (!secret) {
    return Response.json({ error: 'server misconfigured: no admin HMAC secret' }, { status: 503 });
  }

  let jobId: string;
  try {
    const body = (await request.json()) as { jobId?: unknown };
    if (typeof body.jobId !== 'string' || body.jobId.length === 0) {
      return Response.json({ error: 'jobId required' }, { status: 400 });
    }
    jobId = body.jobId;
  } catch {
    return Response.json({ error: 'invalid body' }, { status: 400 });
  }

  // Derive actor from the verified session so audit rows can point at a
  // specific login. The admin app uses a single shared passkey, so
  // credentialId alone doesn't distinguish sessions — we append iat.
  let actor = 'admin-app';
  try {
    const { credentialIdB64 } = getPasskeyConfig();
    const credShort = credentialIdB64.slice(0, 12);
    actor = `passkey:${credShort}:${session.iat}`;
  } catch {
    // Config missing — fall back to the app-level identifier.
  }

  const method = action === 'retry' ? 'POST' : 'DELETE';
  const path =
    action === 'retry'
      ? `/admin/jobs/${encodeURIComponent(jobId)}/retry`
      : `/admin/jobs/${encodeURIComponent(jobId)}`;
  const timestamp = String(Date.now());

  // Send retry with no body so the canonical body hash is deterministic
  // on both sides (no re-serialization drift). Neither endpoint currently
  // carries payload fields — when that changes, hash the exact bytes
  // being transmitted.
  const bodyText = '';
  const bodyHash = await sha256Hex(bodyText);
  const canonical = `${method}\n${path}\n${timestamp}\n${actor}\n${bodyHash}`;
  const hmacHex = await hmacSha256Hex(secret, canonical);

  const res = await fetch(`${backendUrl}${path}`, {
    method,
    headers: {
      'x-admin-hmac': hmacHex,
      'x-admin-timestamp': timestamp,
      'x-admin-actor': actor,
    },
  });

  // The retry / remove action just changed which BullMQ set this job
  // lives in. Drop the cached overview + per-job view so the next page
  // load reflects reality instead of waiting out the 10s TTL. Per-state
  // lists have their own 5s TTL, which is tight enough not to bother.
  if (res.ok) {
    await Promise.all([
      invalidateCache('bullmq:overview'),
      invalidateCache(`bullmq:job:${jobId}`),
      invalidateCache('upstash:queue-depths'),
    ]);
  }

  const responseBody = await res.text();
  return new Response(responseBody, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  });
}

async function hmacSha256Hex(secret: string, data: string): Promise<string> {
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

async function sha256Hex(data: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(data));
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}
