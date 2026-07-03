/**
 * Record (or clear) an operator-entered actual bill for one provider in
 * one billing month. The figure lives in the backend's
 * `admin_spend_overrides` Postgres table (reached via the HMAC-gated
 * /admin/spend-overrides endpoints); we session-gate + writes-flag +
 * audit identically to the other `/api/admin/*` mutations.
 *
 * POST body:
 *   { provider, period: "YYYY-MM", amountUsd?: number, note?, clear?: true }
 * Omitting `amountUsd` (or `clear: true`) deletes the override.
 */

import { resolveAdminCaller } from '@/lib/auth/admin-write';
import { invalidateCache } from '@/lib/cache';
import { appendAudit } from '@/lib/clients/auditLog';
import { removeSpendOverride, upsertSpendOverride } from '@/lib/clients/spend-overrides';
import { SPEND_PROVIDERS, type SpendProvider } from '@/lib/clients/spend-pricing';
import { writesEnabled } from '@/lib/writes';

export const runtime = 'edge';

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function POST(request: Request): Promise<Response> {
  const caller = await resolveAdminCaller(request);
  if (!caller) return Response.json({ error: 'unauthorized' }, { status: 401 });

  if (!writesEnabled()) {
    await appendAudit({
      actor: caller.actor,
      action: 'spend.override',
      outcome: 'denied',
      detail: 'ADMIN_WRITES_ENABLED is off',
    });
    return Response.json({ error: 'writes disabled' }, { status: 503 });
  }

  let body: {
    provider?: unknown;
    period?: unknown;
    amountUsd?: unknown;
    note?: unknown;
    clear?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: 'invalid body' }, { status: 400 });
  }

  if (
    typeof body.provider !== 'string' ||
    !SPEND_PROVIDERS.includes(body.provider as SpendProvider)
  ) {
    return Response.json(
      { error: `provider must be one of ${SPEND_PROVIDERS.join(', ')}` },
      { status: 400 }
    );
  }
  const provider = body.provider as SpendProvider;

  if (typeof body.period !== 'string' || !PERIOD_RE.test(body.period)) {
    return Response.json({ error: 'period must be YYYY-MM' }, { status: 400 });
  }
  const period = body.period;

  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : undefined;
  const target = `${provider}:${period}`;

  // Clear when explicitly asked, or when no usable amount is supplied.
  const amount = typeof body.amountUsd === 'number' ? body.amountUsd : Number(body.amountUsd);
  const clearing = body.clear === true || body.amountUsd == null || body.amountUsd === '';

  if (clearing) {
    const removed = await removeSpendOverride(provider, period, caller.actor);
    await appendAudit({
      actor: caller.actor,
      action: 'spend.override.clear',
      target,
      outcome: 'ok',
      detail: removed > 0 ? 'removed' : 'nothing to remove',
    });
    await invalidateCache('spend:summary');
    return Response.json({ ok: true, message: `Cleared actual for ${target}.` });
  }

  if (!Number.isFinite(amount) || amount < 0) {
    return Response.json({ error: 'amountUsd must be a number ≥ 0' }, { status: 400 });
  }
  const amountUsd = Math.round(amount * 100) / 100;

  await upsertSpendOverride({
    provider,
    period,
    amountUsd,
    note,
    updatedAt: new Date().toISOString(),
    actor: caller.actor,
  });
  await appendAudit({
    actor: caller.actor,
    action: 'spend.override.set',
    target,
    outcome: 'ok',
    detail: `$${amountUsd.toFixed(2)}`,
  });
  await invalidateCache('spend:summary');
  return Response.json({ ok: true, message: `Recorded $${amountUsd.toFixed(2)} for ${target}.` });
}
