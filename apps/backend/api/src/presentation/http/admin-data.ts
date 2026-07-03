/**
 * HMAC-gated admin data endpoints: spend overrides + the operator audit
 * log. Both lived in the admin app's Upstash Redis until the Upstash
 * database was retired (2026-07 cost reduction); Postgres is their
 * durable home now, behind the same shared-secret gate as /admin/jobs/*
 * (see ./admin-common).
 *
 * - Spend overrides: operator-entered actual monthly bills, one row per
 *   (period, provider), read/written by the admin Spend page.
 * - Audit log: admin-app actions append into the same tamper-evident
 *   `admin_audit_log` chain the job endpoints already write, so there is
 *   one audit trail instead of two.
 */

import { db } from '@scani/db/connection';
import { adminAuditLog, adminSpendOverrides } from '@scani/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { audit, createAdminGate } from './admin-common';

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const PROVIDER_RE = /^[a-z0-9-]{1,32}$/;
const NOTE_MAX_CHARS = 256;

export interface SpendOverridePayload {
  provider: string;
  period: string;
  amountUsd: number;
  note?: string;
}

export type SpendOverrideValidation =
  | { ok: true; value: SpendOverridePayload }
  | { ok: false; reason: string };

/**
 * Validate an untrusted spend-override upsert payload. The admin app
 * validates against its provider catalog before calling; this re-check
 * only enforces shape so a leaked HMAC secret can't stuff arbitrary
 * blobs into the table. Exported for tests.
 */
export function validateSpendOverridePayload(input: unknown): SpendOverrideValidation {
  const body = input as Partial<Record<keyof SpendOverridePayload, unknown>> | null;
  if (!body || typeof body !== 'object') return { ok: false, reason: 'body must be an object' };
  if (typeof body.provider !== 'string' || !PROVIDER_RE.test(body.provider)) {
    return { ok: false, reason: 'provider must be a short lowercase slug' };
  }
  if (typeof body.period !== 'string' || !PERIOD_RE.test(body.period)) {
    return { ok: false, reason: 'period must be YYYY-MM' };
  }
  if (
    typeof body.amountUsd !== 'number' ||
    !Number.isFinite(body.amountUsd) ||
    body.amountUsd < 0
  ) {
    return { ok: false, reason: 'amountUsd must be a number ≥ 0' };
  }
  if (body.note !== undefined && typeof body.note !== 'string') {
    return { ok: false, reason: 'note must be a string' };
  }
  const note =
    typeof body.note === 'string' ? body.note.trim().slice(0, NOTE_MAX_CHARS) : undefined;
  return {
    ok: true,
    value: {
      provider: body.provider,
      period: body.period,
      amountUsd: Math.round(body.amountUsd * 100) / 100,
      note: note || undefined,
    },
  };
}

// Wire shape the admin app's audit-log page consumes. `result` in the
// table is 'success'|'failure'|'denied'; the admin UI speaks
// 'ok'|'error'|'denied'.
const RESULT_TO_OUTCOME: Record<string, 'ok' | 'error' | 'denied'> = {
  success: 'ok',
  failure: 'error',
  denied: 'denied',
};
const OUTCOME_TO_RESULT: Record<string, 'success' | 'failure' | 'denied'> = {
  ok: 'success',
  error: 'failure',
  denied: 'denied',
};

// biome-ignore lint/suspicious/noExplicitAny: Elysia accumulates route types; match whatever shape the caller has.
export function registerAdminDataRoutes(app: any, redis?: Redis | null): void {
  const { secret, authenticate, authFailureBody } = createAdminGate('admin-data', redis);

  app
    // biome-ignore lint/suspicious/noExplicitAny: Elysia handler ctx types are dynamic
    .get('/admin/spend-overrides', async ({ request, set }: any) => {
      const actor = await authenticate(request, 'GET', set);
      if (!actor) return authFailureBody(set.status);
      const rows = await db
        .select()
        .from(adminSpendOverrides)
        .orderBy(desc(adminSpendOverrides.period));
      return {
        overrides: rows.map((r) => ({
          provider: r.provider,
          period: r.period,
          amountUsd: Number(r.amountUsd),
          note: r.note ?? undefined,
          actor: r.actor,
          updatedAt: r.updatedAt.toISOString(),
        })),
      };
    })
    // biome-ignore lint/suspicious/noExplicitAny: Elysia handler ctx types are dynamic
    .put('/admin/spend-overrides', async ({ request, set }: any) => {
      const actor = await authenticate(request, 'PUT', set);
      if (!actor) return authFailureBody(set.status);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await request.clone().text());
      } catch {
        set.status = 400;
        return { error: 'body must be JSON' };
      }
      const v = validateSpendOverridePayload(parsed);
      if (!v.ok) {
        set.status = 400;
        return { error: v.reason };
      }
      const { provider, period, amountUsd, note } = v.value;
      const amount = amountUsd.toFixed(2);
      await db
        .insert(adminSpendOverrides)
        .values({ provider, period, amountUsd: amount, note, actor })
        .onConflictDoUpdate({
          target: [adminSpendOverrides.period, adminSpendOverrides.provider],
          set: { amountUsd: amount, note: note ?? null, actor, updatedAt: new Date() },
        });
      await audit(
        actor,
        'spend.override.set',
        `${provider}:${period}`,
        'success',
        { amountUsd, note },
        secret
      );
      return { ok: true };
    })
    // biome-ignore lint/suspicious/noExplicitAny: Elysia handler ctx types are dynamic
    .delete('/admin/spend-overrides/:provider/:period', async ({ params, request, set }: any) => {
      const actor = await authenticate(request, 'DELETE', set);
      if (!actor) return authFailureBody(set.status);
      const provider = String(params.provider);
      const period = String(params.period);
      if (!PROVIDER_RE.test(provider) || !PERIOD_RE.test(period)) {
        set.status = 400;
        return { error: 'bad provider or period' };
      }
      const removed = await db
        .delete(adminSpendOverrides)
        .where(
          and(eq(adminSpendOverrides.provider, provider), eq(adminSpendOverrides.period, period))
        )
        .returning({ period: adminSpendOverrides.period });
      await audit(
        actor,
        'spend.override.clear',
        `${provider}:${period}`,
        'success',
        { removed: removed.length },
        secret
      );
      return { ok: true, removed: removed.length };
    })
    // biome-ignore lint/suspicious/noExplicitAny: Elysia handler ctx types are dynamic
    .get('/admin/audit-log', async ({ request, set }: any) => {
      const actor = await authenticate(request, 'GET', set);
      if (!actor) return authFailureBody(set.status);
      const url = new URL(request.url);
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      const rows = await db
        .select()
        .from(adminAuditLog)
        .orderBy(desc(adminAuditLog.createdAt))
        .limit(limit);
      return {
        entries: rows.map((r) => {
          const details = (r.details ?? {}) as Record<string, unknown>;
          const detail =
            typeof details.detail === 'string'
              ? details.detail
              : Object.keys(details).length > 0
                ? JSON.stringify(details)
                : undefined;
          return {
            ts: r.createdAt.toISOString(),
            actor: r.actor,
            action: r.action,
            target: r.resource === '-' ? undefined : r.resource,
            outcome: RESULT_TO_OUTCOME[r.result] ?? 'error',
            detail,
          };
        }),
      };
    })
    // biome-ignore lint/suspicious/noExplicitAny: Elysia handler ctx types are dynamic
    .post('/admin/audit-log', async ({ request, set }: any) => {
      const actor = await authenticate(request, 'POST', set);
      if (!actor) return authFailureBody(set.status);
      let parsed: {
        action?: unknown;
        target?: unknown;
        outcome?: unknown;
        detail?: unknown;
      };
      try {
        parsed = JSON.parse(await request.clone().text()) as typeof parsed;
      } catch {
        set.status = 400;
        return { error: 'body must be JSON' };
      }
      if (typeof parsed.action !== 'string' || parsed.action.length === 0) {
        set.status = 400;
        return { error: 'action required' };
      }
      const result = OUTCOME_TO_RESULT[String(parsed.outcome)];
      if (!result) {
        set.status = 400;
        return { error: 'outcome must be ok|error|denied' };
      }
      const resource = typeof parsed.target === 'string' && parsed.target ? parsed.target : '-';
      const detail = typeof parsed.detail === 'string' ? parsed.detail : undefined;
      await audit(actor, parsed.action, resource, result, detail ? { detail } : {}, secret);
      return { ok: true };
    });
}
