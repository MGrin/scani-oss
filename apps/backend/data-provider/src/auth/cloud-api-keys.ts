/**
 * DB-backed API-key verification + management for Tier 2/3 managed mode.
 *
 * Presented tokens are hashed with SHA-256 and looked up against
 * `cloud_api_keys.hashed_key`. Revoked or past-due keys fail closed.
 * Last-used timestamps are updated best-effort (fire-and-forget).
 *
 * Tier-1 OSS continues to use the env-based bearer check from
 * `validateBearerToken` — this module is only imported when
 * `CLOUD_MANAGEMENT_ENABLED=true` and `DATABASE_URL` is set.
 */

import { type CloudApiKey, cloudApiKeys } from '@scani/db';
import { logger } from '@scani/logging';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { CloudDb } from '../db/connection';

export interface VerifiedCloudKey {
  apiKeyId: string;
  tenantId: string;
  ownerUserId: string;
  tier: CloudApiKey['tier'];
  billingStatus: CloudApiKey['billingStatus'];
  quotaMonthlyRequests: number | null;
}

export async function verifyCloudApiKey(
  db: CloudDb,
  rawToken: string
): Promise<VerifiedCloudKey | null> {
  const hashed = await sha256Hex(rawToken);
  const rows = await db
    .select()
    .from(cloudApiKeys)
    .where(and(eq(cloudApiKeys.hashedKey, hashed), isNull(cloudApiKeys.revokedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.billingStatus === 'suspended' || row.billingStatus === 'cancelled') {
    return null;
  }
  // Fire-and-forget last-used bump; don't block the request.
  db.update(cloudApiKeys)
    .set({ lastUsedAt: sql`now()` })
    .where(eq(cloudApiKeys.id, row.id))
    .catch((err) => {
      logger.warn({ err, apiKeyId: row.id }, 'failed to bump cloud_api_keys.last_used_at');
    });
  return {
    apiKeyId: row.id,
    tenantId: row.tenantId,
    ownerUserId: row.ownerUserId,
    tier: row.tier as CloudApiKey['tier'],
    billingStatus: row.billingStatus as CloudApiKey['billingStatus'],
    quotaMonthlyRequests: row.quotaMonthlyRequests,
  };
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate a new raw token + its SHA-256 hash + a human-readable prefix.
 * Raw token format: `sk_live_` + 32 hex chars (128 bits entropy).
 * Callers (the `keys.create` tRPC mutation) show the raw token to the user
 * exactly once and persist only the hash.
 */
export async function generateCloudApiKey(): Promise<{
  rawToken: string;
  hashedKey: string;
  keyPrefix: string;
}> {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const rawToken = `sk_live_${hex}`;
  const hashedKey = await sha256Hex(rawToken);
  const keyPrefix = rawToken.slice(0, 12);
  return { rawToken, hashedKey, keyPrefix };
}
