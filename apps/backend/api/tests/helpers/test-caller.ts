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
import { InMemoryInflowRateLimiter } from '@scani/rate-limiter';
import { appRouter } from '../../src/presentation/router';
import type { Context } from '../../src/presentation/trpc';

// Generous limit so tests never accidentally trip the rate limiter.
const testSessionRevokeLimiter = new InMemoryInflowRateLimiter({
  windowMs: 60_000,
  max: 1000,
  namespace: 'rl:test-session-revoke',
});

export function buildAuthedContext(
  dbUser: typeof schema.users.$inferSelect,
  opts: { sessionCreatedAt?: Date | null } = {}
): Context {
  return {
    requestId: `test-${dbUser.id}`,
    startTime: Date.now(),
    requestCache: new Map(),
    headers: null,
    sessionRevokeLimiter: testSessionRevokeLimiter,
    userId: dbUser.id,
    email: dbUser.email ?? null,
    isAuthenticated: true,
    // A just-signed-in session by default, so fresh-session gates pass.
    sessionCreatedAt: opts.sessionCreatedAt === undefined ? new Date() : opts.sessionCreatedAt,
    dbUser,
  };
}

export function buildUnauthedContext(): Context {
  return {
    requestId: 'test-unauthed',
    startTime: Date.now(),
    requestCache: new Map(),
    headers: null,
    sessionRevokeLimiter: testSessionRevokeLimiter,
    userId: null,
    email: null,
    isAuthenticated: false,
    sessionCreatedAt: null,
    dbUser: null,
  };
}

/**
 * Authenticated tRPC caller bound to `dbUser`. The caller short-circuits
 * `requireAuth` because `dbUser` is already on the context.
 */
export function makeAuthedCaller(
  dbUser: typeof schema.users.$inferSelect,
  opts: { sessionCreatedAt?: Date | null } = {}
) {
  return appRouter.createCaller(buildAuthedContext(dbUser, opts));
}

export function makeUnauthedCaller() {
  return appRouter.createCaller(buildUnauthedContext());
}
