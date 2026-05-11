/**
 * Restart a Fly machine.
 *
 * Vendor-direct: admin uses `FLY_API_TOKEN` directly against the
 * Machines REST API. Audit-logged and feature-flag-gated identically.
 */

import { resolveAdminCaller } from '@/lib/auth/admin-write';
import { invalidateCache } from '@/lib/cache';
import { appendAudit } from '@/lib/clients/auditLog';
import { getEnv } from '@/lib/env';
import { writesEnabled } from '@/lib/writes';

export const runtime = 'edge';

const FLY_MACHINES = 'https://api.machines.dev/v1';

export async function POST(request: Request): Promise<Response> {
  const caller = await resolveAdminCaller(request);
  if (!caller) return Response.json({ error: 'unauthorized' }, { status: 401 });

  if (!writesEnabled()) {
    await appendAudit({
      actor: caller.actor,
      action: 'fly.restart-machine',
      outcome: 'denied',
      detail: 'ADMIN_WRITES_ENABLED is off',
    });
    return Response.json({ error: 'writes disabled' }, { status: 503 });
  }

  let app: string;
  let machineId: string;
  try {
    const body = (await request.json()) as { app?: unknown; machineId?: unknown };
    if (typeof body.app !== 'string' || body.app.length === 0) {
      return Response.json({ error: 'app required' }, { status: 400 });
    }
    if (typeof body.machineId !== 'string' || body.machineId.length === 0) {
      return Response.json({ error: 'machineId required' }, { status: 400 });
    }
    app = body.app;
    machineId = body.machineId;
  } catch {
    return Response.json({ error: 'invalid body' }, { status: 400 });
  }

  const token = getEnv('FLY_API_TOKEN');
  if (!token) {
    return Response.json({ error: 'FLY_API_TOKEN missing' }, { status: 503 });
  }

  const res = await fetch(
    `${FLY_MACHINES}/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}/restart`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    }
  );
  const ok = res.ok;

  await appendAudit({
    actor: caller.actor,
    action: 'fly.restart-machine',
    target: `${app}/${machineId}`,
    outcome: ok ? 'ok' : 'error',
    detail: ok ? undefined : `Fly returned ${res.status}`,
  });

  if (ok) {
    await invalidateCache(`fly:machines:${app}`);
  }

  if (!ok) {
    const detail = await res.text().catch(() => '');
    return Response.json(
      { ok: false, error: detail || `HTTP ${res.status}` },
      { status: res.status }
    );
  }
  return Response.json({ ok: true, message: `Restart requested for ${app}/${machineId}.` });
}
