/**
 * Cloud API key management for cloud-frontend users.
 *
 * All procedures are `cookieProcedure` (Better-Auth session required). Keys
 * are scoped to the authenticated cloud_user via `ownerUserId`. The raw
 * token is returned on `create` exactly once (display-copy-once pattern);
 * subsequent `list` calls only return the non-sensitive `keyPrefix`.
 */

import { cloudApiKeys } from '@scani/db';
import { TRPCError } from '@trpc/server';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { generateCloudApiKey } from '../../auth/cloud-api-keys';
import type { CloudDb } from '../../db/connection';
import { cookieProcedure, router } from '../trpc';

// Data-provider currently uses a module-level `cloudDb` handle that's
// installed by `index.ts` at boot. Routers reach it via this accessor so
// we can swap in a test DB without touching boot code.
let cloudDbRef: CloudDb | null = null;
export function installCloudDb(db: CloudDb | null): void {
  cloudDbRef = db;
}

function requireDb(): CloudDb {
  if (!cloudDbRef) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Cloud management is disabled (DATABASE_URL unset)',
    });
  }
  return cloudDbRef;
}

/**
 * The plan a self-service key is minted at, and the only one.
 *
 * `tier` used to be a caller-supplied input, so a signed-up user could
 * mint themselves an `internal` key and get HTTP 200 for it (SC-585).
 * That made the tier column worthless as an authority: `internalProcedure`
 * gates `storage.*` and `email.send` on `cloud_api_keys.tier === 'internal'`,
 * and a lock whose key is handed to the caller is not a lock.
 *
 * Every other tier — `starter`, `pro`, `enterprise`, `internal` — is now
 * reachable only by writing the row directly. That is deliberate: two of
 * them are billing decisions that no endpoint should make on a caller's
 * say-so, and the fourth is an authorization grant.
 */
const SELF_SERVICE_TIER = 'free';

export const keysRouter = router({
  list: cookieProcedure.query(async ({ ctx }) => {
    const db = requireDb();
    const rows = await db
      .select({
        id: cloudApiKeys.id,
        name: cloudApiKeys.name,
        keyPrefix: cloudApiKeys.keyPrefix,
        tier: cloudApiKeys.tier,
        billingStatus: cloudApiKeys.billingStatus,
        quotaMonthlyRequests: cloudApiKeys.quotaMonthlyRequests,
        lastUsedAt: cloudApiKeys.lastUsedAt,
        revokedAt: cloudApiKeys.revokedAt,
        createdAt: cloudApiKeys.createdAt,
      })
      .from(cloudApiKeys)
      .where(eq(cloudApiKeys.ownerUserId, ctx.cloudUser.id))
      .orderBy(desc(cloudApiKeys.createdAt));
    return rows;
  }),

  create: cookieProcedure
    .input(
      // `.strict()`, so a caller that still sends `tier` is REFUSED with a
      // 400 naming the key rather than silently minted at `free` with a
      // 200. Zod strips unknown keys by default, and a success code over
      // an ignored authorization request is the shape that leaves both
      // sides believing something different happened.
      z
        .object({
          name: z.string().min(1).max(80),
          quotaMonthlyRequests: z.number().int().positive().nullable().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const db = requireDb();
      const { rawToken, hashedKey, keyPrefix } = await generateCloudApiKey();
      const [row] = await db
        .insert(cloudApiKeys)
        .values({
          ownerUserId: ctx.cloudUser.id,
          // Tenant = owner for single-user workspaces. When organizations
          // land, swap this for the org id resolved from the session.
          tenantId: ctx.cloudUser.id,
          name: input.name,
          keyPrefix,
          hashedKey,
          tier: SELF_SERVICE_TIER,
          quotaMonthlyRequests: input.quotaMonthlyRequests ?? null,
        })
        .returning();
      if (!row) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Key insert returned no row',
        });
      }
      // Raw token is returned EXACTLY ONCE here; never persisted.
      return {
        id: row.id,
        name: row.name,
        keyPrefix: row.keyPrefix,
        tier: row.tier,
        rawToken,
        createdAt: row.createdAt,
      };
    }),

  revoke: cookieProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = requireDb();
      const result = await db
        .update(cloudApiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(cloudApiKeys.id, input.id), eq(cloudApiKeys.ownerUserId, ctx.cloudUser.id)))
        .returning({ id: cloudApiKeys.id });
      if (result.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Key not found or not owned by user' });
      }
      return { id: result[0]?.id };
    }),
});
