/**
 * DB-backed API-key verification + management for Tier 2/3 managed mode.
 *
 * Presented tokens are hashed with SHA-256 and looked up against
 * `cloud_api_keys.hashed_key`. Revoked and billing-blocked keys fail
 * closed, but the lookup reports WHICH so the caller can say so.
 * Last-used timestamps are updated best-effort (fire-and-forget).
 *
 * Tier-1 OSS continues to use the env-based bearer check from
 * `validateBearerToken` — this module is only imported when
 * `CLOUD_MANAGEMENT_ENABLED=true` and `DATABASE_URL` is set.
 */

import { type CloudApiKey, cloudApiKeys } from '@scani/db';
import { logger } from '@scani/logging';
import { eq, sql } from 'drizzle-orm';
import type { CloudDb } from '../db/connection';

export interface VerifiedCloudKey {
  apiKeyId: string;
  tenantId: string;
  ownerUserId: string;
  tier: CloudApiKey['tier'];
  billingStatus: CloudApiKey['billingStatus'];
  quotaMonthlyRequests: number | null;
}

/**
 * Why a presented key was refused.
 *
 * The lookup deliberately does NOT filter revoked rows out in SQL: an
 * operator whose key was revoked was told the header was missing, and
 * spent the outage auditing proxies and env wiring instead of reading
 * the console that revoked it (SC-106). Telling the caller which of
 * these happened leaks nothing — they already hold the key.
 */
export type CloudKeyLookup =
  | { status: 'valid'; key: VerifiedCloudKey }
  | { status: 'revoked'; revokedAt: Date }
  | { status: 'billing-blocked'; billingStatus: 'suspended' | 'cancelled' }
  | { status: 'unknown' };

export async function verifyCloudApiKey(db: CloudDb, rawToken: string): Promise<CloudKeyLookup> {
  const hashed = await sha256Hex(rawToken);
  const rows = await db
    .select()
    .from(cloudApiKeys)
    .where(eq(cloudApiKeys.hashedKey, hashed))
    .limit(1);
  const row = rows[0];
  if (!row) return { status: 'unknown' };
  if (row.revokedAt) return { status: 'revoked', revokedAt: row.revokedAt };
  if (row.billingStatus === 'suspended' || row.billingStatus === 'cancelled') {
    return { status: 'billing-blocked', billingStatus: row.billingStatus };
  }
  // Fire-and-forget last-used bump; don't block the request.
  db.update(cloudApiKeys)
    .set({ lastUsedAt: sql`now()` })
    .where(eq(cloudApiKeys.id, row.id))
    .catch((err) => {
      logger.warn({ err, apiKeyId: row.id }, 'failed to bump cloud_api_keys.last_used_at');
    });
  return {
    status: 'valid',
    key: {
      apiKeyId: row.id,
      tenantId: row.tenantId,
      ownerUserId: row.ownerUserId,
      tier: row.tier as CloudApiKey['tier'],
      billingStatus: row.billingStatus as CloudApiKey['billingStatus'],
      quotaMonthlyRequests: row.quotaMonthlyRequests,
    },
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
 * Prefix for every cloud API key we mint.
 *
 * Deliberately NOT `sk_live_`, which is Stripe's secret-key prefix and the
 * most widely scanned secret shape there is. Under it every Scani key read
 * as a Stripe credential to tooling neither we nor our customers control:
 * a customer pasting theirs anywhere scanned had it quarantined as Stripe's,
 * a leaked Scani key sent whoever found it to a Stripe account that had
 * nothing to do with us, our own public repo tripped push protection on any
 * realistic key in a fixture, and — the direction nobody expects — a real
 * Stripe key pasted into a Scani ticket read as one of ours and got none of
 * the urgency a live payment credential is owed (SC-189).
 *
 * A prefix exists so a found key names its issuer. This one does.
 *
 * Changing it needs no migration and no dual-accept window: `verifyCloudApiKey`
 * hashes the whole presented token and looks up `hashed_key`, and
 * `validateBearerToken` only checks the `bearer ` scheme. Nothing on the auth
 * path reads these bytes, so keys minted under the old prefix keep working
 * indefinitely and simply carry their original `key_prefix` for display.
 */
export const CLOUD_API_KEY_PREFIX = 'scani_sk_';

// Hex characters shown after the prefix in the console's key list. Enough to
// tell two keys apart; far short of the 32 that would make one guessable.
const KEY_PREFIX_HEX_CHARS = 4;

/**
 * Generate a new raw token + its SHA-256 hash + a human-readable prefix.
 * Raw token format: {@link CLOUD_API_KEY_PREFIX} + 32 hex chars (128 bits
 * entropy). Callers (the `keys.create` tRPC mutation) show the raw token to
 * the user exactly once and persist only the hash.
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
  const rawToken = `${CLOUD_API_KEY_PREFIX}${hex}`;
  const hashedKey = await sha256Hex(rawToken);
  const keyPrefix = rawToken.slice(0, CLOUD_API_KEY_PREFIX.length + KEY_PREFIX_HEX_CHARS);
  return { rawToken, hashedKey, keyPrefix };
}
