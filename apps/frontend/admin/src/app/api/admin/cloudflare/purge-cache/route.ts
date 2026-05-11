/**
 * Purge a Cloudflare zone's cache.
 *
 * Vendor-direct: the admin already holds `CLOUDFLARE_API_TOKEN`
 * server-side for read-only zones/Pages/R2 queries, and the same token
 * scope covers `zones/<id>/purge_cache`. We don't need to round-trip
 * through the backend for this one — but we still HMAC-gate +
 * audit-log + feature-flag identically.
 */

import { resolveAdminCaller } from '@/lib/auth/admin-write';
import { invalidateCache } from '@/lib/cache';
import { appendAudit } from '@/lib/clients/auditLog';
import { getEnv } from '@/lib/env';
import { writesEnabled } from '@/lib/writes';

export const runtime = 'edge';

const CF_BASE = 'https://api.cloudflare.com/client/v4';

export async function POST(request: Request): Promise<Response> {
  const caller = await resolveAdminCaller(request);
  if (!caller) return Response.json({ error: 'unauthorized' }, { status: 401 });

  if (!writesEnabled()) {
    await appendAudit({
      actor: caller.actor,
      action: 'cloudflare.purge-cache',
      outcome: 'denied',
      detail: 'ADMIN_WRITES_ENABLED is off',
    });
    return Response.json({ error: 'writes disabled' }, { status: 503 });
  }

  let zoneId: string;
  let purgeEverything: boolean;
  let files: string[] | undefined;
  try {
    const body = (await request.json()) as {
      zoneId?: unknown;
      purgeEverything?: unknown;
      files?: unknown;
    };
    if (typeof body.zoneId !== 'string' || body.zoneId.length === 0) {
      return Response.json({ error: 'zoneId required' }, { status: 400 });
    }
    zoneId = body.zoneId;
    purgeEverything = body.purgeEverything === true;
    if (Array.isArray(body.files)) {
      files = body.files.filter((x): x is string => typeof x === 'string');
    }
    if (!purgeEverything && !files?.length) {
      return Response.json(
        { error: 'must provide purgeEverything=true or a non-empty files array' },
        { status: 400 }
      );
    }
  } catch {
    return Response.json({ error: 'invalid body' }, { status: 400 });
  }

  const token = getEnv('CLOUDFLARE_API_TOKEN');
  if (!token) {
    return Response.json({ error: 'CLOUDFLARE_API_TOKEN missing' }, { status: 503 });
  }

  const res = await fetch(`${CF_BASE}/zones/${encodeURIComponent(zoneId)}/purge_cache`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(purgeEverything ? { purge_everything: true } : { files }),
    cache: 'no-store',
  });
  const raw = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    errors?: Array<{ message: string }>;
  };
  const ok = res.ok && raw.success === true;

  await appendAudit({
    actor: caller.actor,
    action: 'cloudflare.purge-cache',
    target: `zone:${zoneId}`,
    outcome: ok ? 'ok' : 'error',
    detail: purgeEverything ? 'purge_everything=true' : `files=${files?.length ?? 0}`,
  });

  if (ok) {
    // Pages-project + DNS-record reads aren't cache-tied to purge, but
    // billing-history can shift after a purge in some plans. Drop it
    // to be safe.
    await invalidateCache('cloudflare:billing-history');
  }

  if (!ok) {
    return Response.json(
      {
        ok: false,
        error: raw.errors?.map((e) => e.message).join('; ') ?? `HTTP ${res.status}`,
      },
      { status: res.status === 200 ? 502 : res.status }
    );
  }
  return Response.json({
    ok: true,
    message: purgeEverything ? 'Entire zone purged.' : `Purged ${files?.length ?? 0} URL(s).`,
  });
}
