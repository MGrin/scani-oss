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
}

export const OSS_KEY_ID = 'oss-shared-key';

export interface ValidateBearerOptions {
  authHeader: string | null | undefined;
  expectedToken: string | undefined;
  cloudDb?: CloudDb | null;
}

export async function validateBearerToken(opts: ValidateBearerOptions): Promise<ApiKeyContext> {
  const { authHeader, expectedToken, cloudDb } = opts;

  if (!expectedToken && !cloudDb) {
    // Dev-mode boot: no env key, no DB. Accept everything so local
    // docker-compose "just works". Prod's env schema enforces min length.
    return { apiKeyId: OSS_KEY_ID, tenantId: 'dev', ownerUserId: null, tier: 'oss' };
  }

  if (!authHeader?.toLowerCase().startsWith('bearer ')) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Missing Bearer token' });
  }
  const presented = authHeader.slice('bearer '.length).trim();

  // Env-token superuser path (works in both tiers).
  if (expectedToken && timingSafeEqual(presented, expectedToken)) {
    return { apiKeyId: OSS_KEY_ID, tenantId: 'oss', ownerUserId: null, tier: 'oss' };
  }

  // Tier 2/3 DB lookup.
  if (cloudDb) {
    const verified = await verifyCloudApiKey(cloudDb, presented);
    if (verified) {
      return {
        apiKeyId: verified.apiKeyId,
        tenantId: verified.tenantId,
        ownerUserId: verified.ownerUserId,
        tier: 'managed',
      };
    }
  }

  throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid API key' });
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
