import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import type { BetterAuthInstance } from '../../auth/better-auth';

const authLogger = createComponentLogger('auth');

export interface AuthContext {
  userId: string | null;
  email: string | null;
  isAuthenticated: boolean;
  dbUser?: typeof schema.users.$inferSelect | null;
}

export interface CreateContextOptions {
  req: Request;
  /**
   * Better-Auth instance, wired at boot. Used to resolve the session
   * cookie on every request.
   */
  betterAuth: BetterAuthInstance;
}

/**
 * Resolve the Better-Auth session cookie to a user. The client sends
 * the cookie via `credentials: 'include'`; we hand its headers to
 * `betterAuth.api.getSession`.
 */
export async function createAuthContext(opts: CreateContextOptions): Promise<AuthContext> {
  try {
    const result = await opts.betterAuth.api.getSession({ headers: opts.req.headers });
    if (result?.user) {
      return {
        userId: result.user.id,
        email: result.user.email ?? null,
        isAuthenticated: true,
        dbUser: null,
      };
    }
    return { userId: null, email: null, isAuthenticated: false, dbUser: null };
  } catch (error) {
    // Error (not warn): a thrown `getSession` points at infra degradation
    // (session table locked, DB slow, Better-Auth misconfigured). A spike
    // here silently logs everyone out, so we want dashboards to page.
    authLogger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        // Tag for the Sentry/alerting layer to slice on.
        auth_failure_category: 'session_resolution',
      },
      'Better-Auth getSession failed'
    );
    return { userId: null, email: null, isAuthenticated: false, dbUser: null };
  }
}

/**
 * Middleware to ensure the request is authenticated + load the user's
 * DB row. Better-Auth creates the row on signup, so the lookup here
 * normally hits an existing user. If it doesn't (e.g. a stale session
 * cookie whose user row was deleted), the request is rejected as
 * UNAUTHORIZED rather than silently creating a ghost row.
 */
export async function requireAuth(ctx: AuthContext) {
  if (!ctx.isAuthenticated || !ctx.userId) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
  }

  let dbUser = ctx.dbUser;
  if (!dbUser) {
    try {
      const [existingUser] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, ctx.userId))
        .limit(1);
      dbUser = existingUser ?? null;
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      authLogger.error(
        {
          userId: ctx.userId,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : error,
        },
        'Error fetching user'
      );
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch user data',
        cause: error,
      });
    }
  }

  if (!dbUser) {
    authLogger.warn(
      { userId: ctx.userId },
      'Valid session but no matching user row — stale session, forcing re-auth'
    );
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'User not found',
    });
  }

  return {
    userId: ctx.userId,
    email: ctx.email,
    dbUser,
  };
}
