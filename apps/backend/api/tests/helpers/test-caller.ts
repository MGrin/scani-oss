/**
 * Integration-test helper: build a synthetic tRPC caller for the api
 * router with a pre-resolved authenticated context.
 *
 * Avoids standing up Better-Auth in tests. The runtime path resolves
 * `ctx.dbUser` lazily via `requireAuth(ctx)` only when `ctx.dbUser` is
 * not already populated; passing it in directly bypasses the lookup
 * and the Better-Auth instance.
 */

import type * as schema from '@scani/db/schema';
import { appRouter } from '../../src/presentation/router';
import type { Context } from '../../src/presentation/trpc';

export function buildAuthedContext(dbUser: typeof schema.users.$inferSelect): Context {
  return {
    requestId: `test-${dbUser.id}`,
    startTime: Date.now(),
    requestCache: new Map(),
    headers: null,
    userId: dbUser.id,
    email: dbUser.email ?? null,
    isAuthenticated: true,
    dbUser,
  };
}

export function buildUnauthedContext(): Context {
  return {
    requestId: 'test-unauthed',
    startTime: Date.now(),
    requestCache: new Map(),
    headers: null,
    userId: null,
    email: null,
    isAuthenticated: false,
    dbUser: null,
  };
}

/**
 * Authenticated tRPC caller bound to `dbUser`. The caller short-circuits
 * `requireAuth` because `dbUser` is already on the context.
 */
export function makeAuthedCaller(dbUser: typeof schema.users.$inferSelect) {
  return appRouter.createCaller(buildAuthedContext(dbUser));
}

export function makeUnauthedCaller() {
  return appRouter.createCaller(buildUnauthedContext());
}
