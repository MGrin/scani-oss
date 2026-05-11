/**
 * Replay a job from `scani-dlq` back onto `scani-jobs`.
 *
 * Backend-proxied: BullMQ's internal data model spans multiple Redis
 * keys (waiting list / id counter / metadata) that can't be mutated
 * safely from raw Upstash REST. The backend holds a `WorkerClient`
 * with the BullMQ library loaded; this route HMACs the request to
 * `/admin/dlq/<id>/replay` on the api.
 *
 * Backend route ships separately. Until then the call returns the
 * backend's 404 and the audit row records `outcome: error`. The
 * `ADMIN_WRITES_ENABLED=0` default prevents accidental clicks in prod.
 */

import { proxyToBackend, resolveAdminCaller } from '@/lib/auth/admin-write';
import { appendAudit } from '@/lib/clients/auditLog';
import { writesEnabled } from '@/lib/writes';

export const runtime = 'edge';

export async function POST(request: Request): Promise<Response> {
  const caller = await resolveAdminCaller(request);
  if (!caller) return Response.json({ error: 'unauthorized' }, { status: 401 });

  if (!writesEnabled()) {
    await appendAudit({
      actor: caller.actor,
      action: 'dlq.replay',
      outcome: 'denied',
      detail: 'ADMIN_WRITES_ENABLED is off',
    });
    return Response.json({ error: 'writes disabled' }, { status: 503 });
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

  return proxyToBackend({
    caller,
    action: 'dlq.replay',
    target: jobId,
    method: 'POST',
    path: `/admin/dlq/${encodeURIComponent(jobId)}/replay`,
    invalidate: ['bullmq:dlq', 'bullmq:overview', 'upstash:queue-depths'],
  });
}
