/**
 * Send a magic-link invite to a waitlist signup.
 *
 * Backend-proxied: emailing goes through the data-provider's
 * `email.send` tRPC, and the magic-link is signed by the api's
 * Better-Auth instance — neither lives in the admin. HMACs through to
 * `/admin/waitlist/<id>/invite`.
 *
 * Backend route ships separately.
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
      action: 'waitlist.invite',
      outcome: 'denied',
      detail: 'ADMIN_WRITES_ENABLED is off',
    });
    return Response.json({ error: 'writes disabled' }, { status: 503 });
  }

  let signupId: string;
  try {
    const body = (await request.json()) as { signupId?: unknown };
    if (typeof body.signupId !== 'string' || body.signupId.length === 0) {
      return Response.json({ error: 'signupId required' }, { status: 400 });
    }
    signupId = body.signupId;
  } catch {
    return Response.json({ error: 'invalid body' }, { status: 400 });
  }

  return proxyToBackend({
    caller,
    action: 'waitlist.invite',
    target: signupId,
    method: 'POST',
    path: `/admin/waitlist/${encodeURIComponent(signupId)}/invite`,
    invalidate: ['app-db:waitlist-stats'],
  });
}
