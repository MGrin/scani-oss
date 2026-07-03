/**
 * Operator-entered actual bills, persisted in Postgres behind the
 * backend's HMAC-gated `/admin/spend-overrides` endpoints.
 *
 * No vendor API exposes the authoritative monthly invoice total for
 * Neon or Fly (only Cloudflare reports real charges), and the live
 * usage APIs only ever return *current* month-to-date — so last month's
 * bill can't be reconstructed from them. The operator records the real
 * figure off each invoice; it supersedes the estimate for that
 * provider+period on the spend page.
 *
 * Previously an Upstash Redis hash (`admin:spend:overrides`); moved to
 * the `admin_spend_overrides` table when the Upstash database was
 * retired (2026-07 cost reduction). Durable records — never expire.
 */

import { type Result, tryCatch } from '../result';
import { signedAdminJson } from './backend-admin';
import type { SpendOverride, SpendProvider } from './spend-pricing';

export async function getSpendOverrides(): Promise<Result<SpendOverride[]>> {
  return tryCatch(async () => {
    const parsed = await signedAdminJson<{ overrides?: SpendOverride[] }>(
      'GET',
      '/admin/spend-overrides'
    );
    return Array.isArray(parsed.overrides) ? parsed.overrides : [];
  });
}

export async function upsertSpendOverride(o: SpendOverride): Promise<void> {
  await signedAdminJson('PUT', '/admin/spend-overrides', {
    actor: o.actor,
    body: { provider: o.provider, period: o.period, amountUsd: o.amountUsd, note: o.note },
  });
}

export async function removeSpendOverride(
  provider: SpendProvider,
  period: string,
  actor?: string
): Promise<number> {
  const parsed = await signedAdminJson<{ removed?: number }>(
    'DELETE',
    `/admin/spend-overrides/${provider}/${period}`,
    { actor }
  );
  return Number(parsed.removed) || 0;
}
