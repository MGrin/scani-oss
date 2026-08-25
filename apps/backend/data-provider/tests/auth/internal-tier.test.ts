/**
 * SC-585 — where `ApiKeyContext.internal` comes from.
 *
 * Three credentials produce it and only two of them are exercised by the
 * env-token tests above: the DB branch (`cloud_api_keys.tier === 'internal'`)
 * is reachable only through a `cloudDb`, so without this file it could be
 * dead code while every other assertion in the suite still passed.
 *
 * Watch the name collision the fix is built on: `ApiKeyContext.tier` is the
 * auth MODE (`oss` = env token, `managed` = DB row) and `cloud_api_keys.tier`
 * is the billing PLAN. `internal` is derived from the second, never the
 * first — `tier: 'managed'` says nothing about authority.
 */

import { describe, expect, it } from 'bun:test';
import { validateBearerToken } from '../../src/auth/api-key';
import { sha256Hex } from '../../src/auth/cloud-api-keys';

const ENV_TOKEN = 'env-superuser-token-1234567890';

/**
 * The narrowest thing `verifyCloudApiKey` actually calls: one
 * `select().from().where().limit()` and a fire-and-forget `update()`.
 */
function fakeCloudDb(row: Record<string, unknown> | null) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (row ? [row] : []),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({ catch: () => undefined }),
      }),
    }),
    // biome-ignore lint/suspicious/noExplicitAny: a hand-narrowed stand-in for CloudDb
  } as any;
}

async function contextForRowTier(tier: string) {
  const rawToken = 'scani_sk_00000000000000000000000000000001';
  return validateBearerToken({
    authHeader: `Bearer ${rawToken}`,
    expectedToken: ENV_TOKEN,
    cloudDb: fakeCloudDb({
      id: '00000000-0000-4000-8000-000000000001',
      tenantId: 'tenant-1',
      ownerUserId: 'owner-1',
      tier,
      billingStatus: 'active',
      quotaMonthlyRequests: null,
      revokedAt: null,
      hashedKey: await sha256Hex(rawToken),
    }),
  });
}

describe('ApiKeyContext.internal', () => {
  it('is true for the env superuser token — what the api and worker present', async () => {
    const ctx = await validateBearerToken({
      authHeader: `Bearer ${ENV_TOKEN}`,
      expectedToken: ENV_TOKEN,
      cloudDb: fakeCloudDb(null),
    });
    expect(ctx.internal).toBe(true);
  });

  it("is true for a DB key whose row tier ops set to 'internal'", async () => {
    const ctx = await contextForRowTier('internal');
    expect(ctx.tier).toBe('managed');
    expect(ctx.internal).toBe(true);
  });

  // Every plan a self-service caller can hold. `keys.create` mints only
  // `free`; the rest are reachable by writing the row, and none of them is
  // an authorization grant.
  for (const tier of ['free', 'starter', 'pro', 'enterprise']) {
    it(`is false for a '${tier}' key`, async () => {
      const ctx = await contextForRowTier(tier);
      expect(ctx.tier).toBe('managed');
      expect(ctx.internal).toBe(false);
    });
  }
});
