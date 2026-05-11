/**
 * Manually trigger one fire of a scheduled job.
 *
 * Backend-proxied: only the worker (well — the api, which is the
 * BullMQ producer) can `queue.add` a one-shot job with the matching
 * name. This route HMACs through to `/admin/schedules/<name>/run`.
 *
 * Backend route ships separately. Default-off feature flag prevents
 * accidental clicks; the audit log records `outcome: error` if the
 * backend isn't ready.
 */

import { proxyToBackend, resolveAdminCaller } from '@/lib/auth/admin-write';
import { appendAudit } from '@/lib/clients/auditLog';
import { writesEnabled } from '@/lib/writes';

export const runtime = 'edge';

const VALID_NAMES = new Set([
  'pricing',
  'wallet-balances',
  'exchange-balances',
  'apy-payouts',
  'reconcile-pending-credentials',
  'reconcile-orphaned-user-jobs',
]);

export async function POST(request: Request): Promise<Response> {
  const caller = await resolveAdminCaller(request);
  if (!caller) return Response.json({ error: 'unauthorized' }, { status: 401 });

  if (!writesEnabled()) {
    await appendAudit({
      actor: caller.actor,
      action: 'schedules.run',
      outcome: 'denied',
      detail: 'ADMIN_WRITES_ENABLED is off',
    });
    return Response.json({ error: 'writes disabled' }, { status: 503 });
  }

  let name: string;
  try {
    const body = (await request.json()) as { name?: unknown };
    if (typeof body.name !== 'string' || !VALID_NAMES.has(body.name)) {
      return Response.json(
        { error: `name must be one of: ${[...VALID_NAMES].join(', ')}` },
        { status: 400 }
      );
    }
    name = body.name;
  } catch {
    return Response.json({ error: 'invalid body' }, { status: 400 });
  }

  return proxyToBackend({
    caller,
    action: 'schedules.run',
    target: name,
    method: 'POST',
    path: `/admin/schedules/${encodeURIComponent(name)}/run`,
    invalidate: ['bullmq:overview', 'upstash:queue-depths'],
  });
}
