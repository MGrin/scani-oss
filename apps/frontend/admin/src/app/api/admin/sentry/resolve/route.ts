/**
 * Resolve a Sentry issue.
 *
 * Vendor-direct: admin's `SENTRY_AUTH_TOKEN` covers `event:write` /
 * `project:write` scope on the orgs we own. The PUT below mutates the
 * issue's status. Audit-logged and feature-flag-gated identically.
 *
 * No matching detail view exists yet on `/platform/sentry` (Phase 1
 * shipped a per-project grid only). When that page adds a per-issue
 * drill-down, the action wires up trivially against this route.
 */

import { resolveAdminCaller } from '@/lib/auth/admin-write';
import { invalidateCache } from '@/lib/cache';
import { appendAudit } from '@/lib/clients/auditLog';
import { getEnv } from '@/lib/env';
import { writesEnabled } from '@/lib/writes';

export const runtime = 'edge';

const SENTRY_BASE = 'https://sentry.io/api/0';

export async function POST(request: Request): Promise<Response> {
  const caller = await resolveAdminCaller(request);
  if (!caller) return Response.json({ error: 'unauthorized' }, { status: 401 });

  if (!writesEnabled()) {
    await appendAudit({
      actor: caller.actor,
      action: 'sentry.resolve',
      outcome: 'denied',
      detail: 'ADMIN_WRITES_ENABLED is off',
    });
    return Response.json({ error: 'writes disabled' }, { status: 503 });
  }

  let issueId: string;
  try {
    const body = (await request.json()) as { issueId?: unknown };
    if (typeof body.issueId !== 'string' || body.issueId.length === 0) {
      return Response.json({ error: 'issueId required' }, { status: 400 });
    }
    issueId = body.issueId;
  } catch {
    return Response.json({ error: 'invalid body' }, { status: 400 });
  }

  const token = getEnv('SENTRY_AUTH_TOKEN');
  if (!token) {
    return Response.json({ error: 'SENTRY_AUTH_TOKEN missing' }, { status: 503 });
  }

  const res = await fetch(`${SENTRY_BASE}/issues/${encodeURIComponent(issueId)}/`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ status: 'resolved' }),
    cache: 'no-store',
  });
  const ok = res.ok;

  await appendAudit({
    actor: caller.actor,
    action: 'sentry.resolve',
    target: `issue:${issueId}`,
    outcome: ok ? 'ok' : 'error',
    detail: ok ? undefined : `Sentry returned ${res.status}`,
  });

  if (ok) {
    await invalidateCache('sentry:overview');
  }

  if (!ok) {
    const detail = await res.text().catch(() => '');
    return Response.json(
      { ok: false, error: detail || `HTTP ${res.status}` },
      { status: res.status }
    );
  }
  return Response.json({ ok: true, message: `Issue ${issueId} resolved.` });
}
