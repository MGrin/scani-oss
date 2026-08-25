import { addBreadcrumb } from '@scani/logging/sentry';
import { TRPCError } from '@trpc/server';
import type { CloudDb } from '../db/connection';
import { verifyCloudApiKey } from './cloud-api-keys';

/**
 * Bearer-token auth for the data-provider's M2M tRPC surface.
 *
 * Two execution modes:
 *
 *   - OSS Tier 1 (`CLOUD_MANAGEMENT_ENABLED=false`, no DB): a single
 *     env-configured bearer token (`DATA_PROVIDER_API_KEY`) is the only
 *     accepted credential. Zero DB traffic.
 *
 *   - Managed Tier 2/3 (`CLOUD_MANAGEMENT_ENABLED=true` + DB): the
 *     presented token is SHA-256 hashed and looked up against
 *     `cloud_api_keys`. The env-based `DATA_PROVIDER_API_KEY` still works
 *     as a superuser fallback so Scani ops can always reach the service.
 *
 * Callers receive a typed {@link ApiKeyContext} either way; downstream
 * middleware (usage log, quota) treats the two modes identically.
 */

export interface ApiKeyContext {
  apiKeyId: string;
  tenantId: string;
  ownerUserId: string | null;
  tier: 'oss' | 'managed';
  /**
   * Whether this credential belongs to Scani itself rather than to a
   * customer. `internalProcedure` gates the nine internal facades
   * (`storage.*`, `email.send`) on it — see SC-585, where a free-tier
   * customer key read, overwrote and deleted objects it never wrote and
   * sent mail as `security@scani.xyz`.
   *
   * Deliberately a separate field rather than a reading of `tier`, which
   * means two different things a line apart: `ApiKeyContext.tier` is the
   * auth MODE (`oss` = env token, `managed` = DB row), while
   * `cloud_api_keys.tier` is the billing plan (`free` … `internal`). A
   * check written as "the tier is internal" is ambiguous between them,
   * and only one of the two answers the question.
   */
  internal: boolean;
}

export const OSS_KEY_ID = 'oss-shared-key';

/**
 * Every way a bearer credential can be refused, said in the caller's
 * terms (SC-106).
 *
 * All of them are still `UNAUTHORIZED` / 401. The only one that may
 * mention the header is the one where the header is genuinely absent —
 * anything else sends an operator to audit proxies and env wiring for a
 * problem that is on our side of the wire. None of them lets a caller
 * probe whether a key they do not hold exists: an unrecognised token is
 * unrecognised whether it was never issued or was deleted with its
 * account.
 */
export const AUTH_MESSAGES = {
  missingHeader: 'Authorization: Bearer <api-key> header required',
  unknownKey: 'API key not recognised — check the key, or create a new one at cloud.scani.xyz',
  revoked: (revokedAt: Date) =>
    `API key was revoked on ${revokedAt.toISOString().slice(0, 10)} — create a new one at cloud.scani.xyz`,
  suspended: 'API key is suspended — check billing at cloud.scani.xyz',
  cancelled: 'API key belongs to a cancelled subscription — reactivate at cloud.scani.xyz',
  superuserExpired: 'Superuser token expired — rotate via DATA_PROVIDER_API_KEY',
  /** The DB lookup itself failed. Not the caller's fault; don't blame their key. */
  verificationFailed: 'Could not verify the API key right now — retry shortly',
} as const;

export interface ValidateBearerOptions {
  authHeader: string | null | undefined;
  expectedToken: string | undefined;
  cloudDb?: CloudDb | null;
  /**
   * ISO-8601 timestamp after which the env-configured superuser token
   * is no longer accepted. Drives the 90-day rotation policy without
   * requiring a deploy: ops sets the new key + the old key's expiry
   * via Fly secrets, then peels the old key off after the window. When
   * unset the env token never expires (legacy behaviour).
   */
  expectedTokenExpiresAt?: Date | null;
}

export async function validateBearerToken(opts: ValidateBearerOptions): Promise<ApiKeyContext> {
  const { authHeader, expectedToken, cloudDb, expectedTokenExpiresAt } = opts;

  if (!expectedToken && !cloudDb) {
    // Dev-mode boot: no env key, no DB. Accept everything so local
    // docker-compose "just works". Prod's env schema enforces min length.
    return {
      apiKeyId: OSS_KEY_ID,
      tenantId: 'dev',
      ownerUserId: null,
      tier: 'oss',
      internal: true,
    };
  }

  if (!authHeader?.toLowerCase().startsWith('bearer ')) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: AUTH_MESSAGES.missingHeader });
  }
  const presented = authHeader.slice('bearer '.length).trim();

  // Env-token superuser path (works in both tiers).
  if (expectedToken && timingSafeEqual(presented, expectedToken)) {
    if (expectedTokenExpiresAt && expectedTokenExpiresAt.getTime() < Date.now()) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: AUTH_MESSAGES.superuserExpired,
      });
    }
    // Trail every superuser invocation in Sentry. This is the only
    // bearer credential without per-key rotation in the DB; if it ever
    // leaks the breadcrumbs make the impact auditable.
    addBreadcrumb({
      category: 'auth.superuser',
      level: 'warning',
      message: 'Data-provider superuser bearer accepted',
      data: {
        expiresAt: expectedTokenExpiresAt?.toISOString() ?? null,
      },
    });
    return {
      apiKeyId: OSS_KEY_ID,
      tenantId: 'oss',
      ownerUserId: null,
      tier: 'oss',
      internal: true,
    };
  }

  // Tier 2/3 DB lookup.
  if (cloudDb) {
    const lookup = await verifyCloudApiKey(cloudDb, presented);
    switch (lookup.status) {
      case 'valid':
        return {
          apiKeyId: lookup.key.apiKeyId,
          tenantId: lookup.key.tenantId,
          ownerUserId: lookup.key.ownerUserId,
          tier: 'managed',
          // A DB key is internal only when its billing plan says so, and
          // no caller can choose that plan: `keys.create` does not accept
          // `tier` (SC-585). Reaching `internal` takes a direct write to
          // `cloud_api_keys`, which is ops, not a signup.
          internal: lookup.key.tier === 'internal',
        };
      case 'revoked':
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: AUTH_MESSAGES.revoked(lookup.revokedAt),
        });
      case 'billing-blocked':
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message:
            lookup.billingStatus === 'suspended'
              ? AUTH_MESSAGES.suspended
              : AUTH_MESSAGES.cancelled,
        });
      case 'unknown':
        break;
    }
  }

  throw new TRPCError({ code: 'UNAUTHORIZED', message: AUTH_MESSAGES.unknownKey });
}

// Constant-time string comparison — prevents leaking the expected token's
// length via response-time side-channel. `crypto.subtle.timingSafeEqual`
// would be ideal but it's not in Bun's web-crypto surface yet; a manual
// XOR accumulator over equal-length padded buffers is good enough for a
// low-traffic admin secret.
function timingSafeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    mismatch |= ca ^ cb;
  }
  return mismatch === 0;
}
