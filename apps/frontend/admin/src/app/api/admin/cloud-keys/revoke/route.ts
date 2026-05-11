/**
 * Revoke a Tier 2/3 cloud API key.
 *
 * DB-direct: the admin already holds the Neon connection string (used
 * read-only by every `db/*` stats module). Stamping `revoked_at = now()`
 * is a single one-row UPDATE — running it from the admin saves a
 * round-trip through the backend and keeps the audit-log shape
 * consistent with the other write actions.
 *
 * Audit-logged and feature-flag-gated identically.
 */

import { neon } from '@neondatabase/serverless';
import { resolveAdminCaller } from '@/lib/auth/admin-write';
import { invalidateCache } from '@/lib/cache';
import { appendAudit } from '@/lib/clients/auditLog';
import { getDatabaseUrl } from '@/lib/clients/neon';
import { writesEnabled } from '@/lib/writes';

export const runtime = 'edge';

export async function POST(request: Request): Promise<Response> {
  const caller = await resolveAdminCaller(request);
  if (!caller) return Response.json({ error: 'unauthorized' }, { status: 401 });

  if (!writesEnabled()) {
    await appendAudit({
      actor: caller.actor,
      action: 'cloud-keys.revoke',
      outcome: 'denied',
      detail: 'ADMIN_WRITES_ENABLED is off',
    });
    return Response.json({ error: 'writes disabled' }, { status: 503 });
  }

  let keyId: string;
  try {
    const body = (await request.json()) as { keyId?: unknown };
    if (typeof body.keyId !== 'string' || body.keyId.length === 0) {
      return Response.json({ error: 'keyId required' }, { status: 400 });
    }
    keyId = body.keyId;
  } catch {
    return Response.json({ error: 'invalid body' }, { status: 400 });
  }

  try {
    const sql = neon(await getDatabaseUrl());
    const rows = (await sql`
      UPDATE cloud_api_keys
      SET revoked_at = now(), updated_at = now()
      WHERE id = ${keyId}
        AND revoked_at IS NULL
      RETURNING id::text, name
    `) as Array<{ id: string; name: string }>;
    const row = rows[0];

    if (!row) {
      await appendAudit({
        actor: caller.actor,
        action: 'cloud-keys.revoke',
        target: keyId,
        outcome: 'error',
        detail: 'no matching active key',
      });
      return Response.json(
        { ok: false, error: 'key not found or already revoked' },
        { status: 404 }
      );
    }

    await appendAudit({
      actor: caller.actor,
      action: 'cloud-keys.revoke',
      target: keyId,
      outcome: 'ok',
      detail: row.name,
    });
    await invalidateCache('app-db:cloud-stats');

    return Response.json({ ok: true, message: `Revoked ${row.name}.` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await appendAudit({
      actor: caller.actor,
      action: 'cloud-keys.revoke',
      target: keyId,
      outcome: 'error',
      detail: message,
    });
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
