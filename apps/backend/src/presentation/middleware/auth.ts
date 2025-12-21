import { db } from '@scani/core/database/connection';
import * as schema from '@scani/core/database/schema';
import { authLogger } from '@scani/core/utils/logger';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { verifySupabaseJWT } from '../../lib/jwt-verify';

export interface AuthContext {
  userId: string | null;
  email: string | null;
  isAuthenticated: boolean;
  dbUser?: typeof schema.users.$inferSelect | null;
}

export interface CreateContextOptions {
  req: Request;
}

/**
 * Creates or updates a user in the database based on JWT user data
 */
async function syncUserWithDatabase(
  userId: string,
  email: string
): Promise<typeof schema.users.$inferSelect> {
  try {
    authLogger.debug({ userId, email }, 'Syncing user with database');

    // Check if user already exists
    const [existingUser] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (existingUser) {
      authLogger.debug({ userId }, 'User found in database, checking for updates');
      // Update existing user email if needed, but never update the name or avatar
      const needsUpdate = existingUser.email !== email;

      if (needsUpdate) {
        const [updatedUser] = await db
          .update(schema.users)
          .set({
            email: email || existingUser.email,
            updatedAt: new Date(),
          })
          .where(eq(schema.users.id, userId))
          .returning();

        return updatedUser || existingUser;
      }

      return existingUser;
    }

    // Create new user
    authLogger.info({ userId, email }, 'Creating new user in database');
    const now = new Date();

    // Extract username from email (everything before @)
    const emailUsername = email?.split('@')[0] || 'User';

    // Get USD token ID as default base currency
    const [usdToken] = await db
      .select({ id: schema.tokens.id })
      .from(schema.tokens)
      .where(eq(schema.tokens.symbol, 'USD'))
      .limit(1);

    const userData = {
      id: userId, // Use JWT user ID
      email: email || '',
      name: emailUsername, // Use email prefix as username
      avatar: null,
      baseCurrencyId: usdToken?.id || null, // Use USD token ID or null if not found
      createdAt: now,
      updatedAt: now,
    };

    const [newUser] = await db.insert(schema.users).values(userData).returning();

    if (!newUser) {
      throw new Error('Failed to create user in database');
    }

    authLogger.info({ userId, email }, 'User created successfully in database');

    return newUser;
  } catch (error) {
    // Enhanced error logging with full error details
    const errorObj = error as Error & {
      code?: string;
      detail?: string;
      hint?: string;
    };

    const errorDetails = {
      userId,
      userEmail: email,
      error:
        error instanceof Error
          ? {
              name: errorObj.name,
              message: errorObj.message,
              stack: errorObj.stack,
              // Include postgres-specific error details if available
              ...(errorObj.code && { code: errorObj.code }),
              ...(errorObj.detail && { detail: errorObj.detail }),
              ...(errorObj.hint && { hint: errorObj.hint }),
            }
          : error,
    };

    authLogger.error(errorDetails, 'Error syncing user with database');

    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to sync user data',
      cause: error,
    });
  }
}

/**
 * Extracts and validates the JWT token from the Authorization header
 * Uses local JWT verification to avoid calling Supabase API for every request
 */
export async function createAuthContext(opts: CreateContextOptions): Promise<AuthContext> {
  const authHeader = opts.req.headers.get('authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {
      userId: null,
      email: null,
      isAuthenticated: false,
      dbUser: null,
    };
  }

  const token = authHeader.substring(7); // Remove "Bearer " prefix

  try {
    // Verify the JWT token locally using JWKS
    const payload = await verifySupabaseJWT(token);

    if (!payload) {
      return {
        userId: null,
        email: null,
        isAuthenticated: false,
        dbUser: null,
      };
    }

    // Sync user with database
    const dbUser = await syncUserWithDatabase(payload.sub, payload.email || '');

    authLogger.debug(
      {
        userId: payload.sub,
      },
      'User authenticated successfully'
    );

    return {
      userId: payload.sub,
      email: payload.email || null,
      isAuthenticated: true,
      dbUser,
    };
  } catch (error) {
    authLogger.error(
      {
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : error,
      },
      'Auth verification error'
    );
    return {
      userId: null,
      email: null,
      isAuthenticated: false,
      dbUser: null,
    };
  }
}

/**
 * Middleware to ensure user is authenticated
 */
export function requireAuth(ctx: AuthContext) {
  if (!ctx.isAuthenticated || !ctx.userId || !ctx.dbUser) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
  }

  return {
    userId: ctx.userId,
    email: ctx.email,
    dbUser: ctx.dbUser,
  };
}
