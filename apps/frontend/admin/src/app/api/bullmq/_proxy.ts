/**
 * Admin → backend proxy for HMAC-gated BullMQ write actions.
 *
 * Middleware already gates `/api/bullmq/*` behind the passkey session.
 * `resolveAdminCaller` re-verifies here (defense in depth) and derives
 * the audit actor; `hmacSha256Hex` signs the outbound request to the
 * backend.
 *
 * Canonical HMAC string (must match `apps/backend/src/presentation/http/admin-jobs.ts`):
 *   `${method}\n${path}\n${timestamp}\n${actor}\n${sha256Hex(rawBody)}`
 */

import { hmacSha256Hex, resolveAdminCaller, sha256Hex } from '@/lib/auth/admin-write';
import { invalidateCache } from '@/lib/cache';
import { appendAudit } from '@/lib/clients/auditLog';
import { getEnv } from '@/lib/env';
import { writesEnabled } from '@/lib/writes';

export async function proxyJobAction(
  request: Request,
  action: 'retry' | 'remove'
): Promise<Response> {
  const caller = await resolveAdminCaller(request);
  if (!caller) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (!writesEnabled()) {
    await appendAudit({
      actor: caller.actor,
      action: `bullmq.${action}`,
      outcome: 'denied',
      detail: 'ADMIN_WRITES_ENABLED is off',
    });
    return Response.json({ error: 'writes disabled' }, { status: 503 });
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
  const canonical = `${method}\n${path}\n${timestamp}\n${caller.actor}\n${bodyHash}`;
  const hmacHex = await hmacSha256Hex(secret, canonical);

  const res = await fetch(`${backendUrl}${path}`, {
    method,
    headers: {
      'x-admin-hmac': hmacHex,
      'x-admin-timestamp': timestamp,
      'x-admin-actor': caller.actor,
    },
  });

  if (res.ok) {
    await Promise.all([
      invalidateCache('bullmq:overview'),
      invalidateCache(`bullmq:job:${jobId}`),
      invalidateCache('upstash:queue-depths'),
    ]);
  }

  await appendAudit({
    actor: caller.actor,
    action: `bullmq.${action}`,
    target: jobId,
    outcome: res.ok ? 'ok' : 'error',
    detail: res.ok ? undefined : `backend returned ${res.status}`,
  });

  const responseBody = await res.text();
  return new Response(responseBody, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  });
}
