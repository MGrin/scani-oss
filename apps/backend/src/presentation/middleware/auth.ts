import { db } from '@scani/core/database/connection';
import * as schema from '@scani/core/database/schema';
import { authLogger } from '@scani/core/utils/logger';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { JwksUnavailableError, verifySupabaseJWT } from '../../lib/jwt-verify';

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
 * Creates a new user in the database if they don't exist
 * Only called when a user with valid JWT is not found in our database
 */
async function createUserIfNotExists(
  userId: string,
  email: string
): Promise<typeof schema.users.$inferSelect> {
  try {
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

    authLogger.error(errorDetails, 'Error creating user in database');

    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to create user',
      cause: error,
    });
  }
}

/**
 * Extracts and validates the JWT token from the Authorization header
 * Uses local JWT verification to avoid calling Supabase API for every request
 * No longer syncs user on every request - only verifies JWT token
 */
export async function createAuthContext(opts: CreateContextOptions): Promise<AuthContext> {
  const authHeader = opts.req.headers.get('authorization');

  if (!authHeader) {
    authLogger.debug('No authorization header present');
    return {
      userId: null,
      email: null,
      isAuthenticated: false,
      dbUser: null,
    };
  }

  if (!authHeader.startsWith('Bearer ')) {
    authLogger.warn(
      { authHeaderPrefix: authHeader.substring(0, 10) },
      'Authorization header does not start with Bearer'
    );
    return {
      userId: null,
      email: null,
      isAuthenticated: false,
      dbUser: null,
    };
  }

  const token = authHeader.substring(7); // Remove "Bearer " prefix
  authLogger.debug({ tokenLength: token.length }, 'Extracted JWT token from header');

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

    authLogger.debug(
      {
        userId: payload.sub,
      },
      'User authenticated successfully'
    );

    // Return auth context without dbUser - it will be fetched lazily when needed
    return {
      userId: payload.sub,
      email: payload.email || null,
      isAuthenticated: true,
      dbUser: null,
    };
  } catch (error) {
    // JWKS unavailable = infrastructure issue, NOT an invalid token. Surface
    // this as a 503 so clients retry instead of logging users out.
    if (error instanceof JwksUnavailableError) {
      authLogger.error(
        {
          error: { name: error.name, message: error.message },
        },
        'Auth verification failed — JWKS unavailable, returning 503'
      );
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Authentication service temporarily unavailable',
        cause: error,
      });
    }

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
 * Fetches dbUser from database if not already present in context
 * Creates user in database if they don't exist (new user)
 */
export async function requireAuth(ctx: AuthContext) {
  if (!ctx.isAuthenticated || !ctx.userId) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
  }

  // Fetch dbUser from database if not already in context
  let dbUser = ctx.dbUser;
  if (!dbUser) {
    try {
      authLogger.debug({ userId: ctx.userId }, 'Fetching user from database');
      const [existingUser] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, ctx.userId))
        .limit(1);

      if (existingUser) {
        dbUser = existingUser;
      } else {
        // User doesn't exist in our database - create them (new user registration)
        authLogger.info({ userId: ctx.userId }, 'User not found in database, creating new user');
        dbUser = await createUserIfNotExists(ctx.userId, ctx.email || '');
      }
    } catch (error) {
      authLogger.error(
        {
          userId: ctx.userId,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : error,
        },
        'Error fetching or creating user'
      );
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch user data',
        cause: error,
      });
    }
  }

  if (!dbUser) {
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
