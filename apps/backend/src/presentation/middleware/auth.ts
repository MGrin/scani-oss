import { db } from '@scani/core/database/connection';
import * as schema from '@scani/core/database/schema';
import { supabase } from '@scani/core/lib/supabase';
import { authLogger } from '@scani/core/utils/logger';
import type { User } from '@supabase/supabase-js';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import jwt, { type JwtPayload } from 'jsonwebtoken';

export interface AuthContext {
  user: User | null;
  isAuthenticated: boolean;
  dbUser?: typeof schema.users.$inferSelect | null;
}

export interface CreateContextOptions {
  req: Request;
}

const SUPABASE_JWT_SECRET =
  process.env.SUPABASE_JWT_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * Creates or updates a user in the database based on Supabase user data
 */
async function syncUserWithDatabase(supabaseUser: User): Promise<typeof schema.users.$inferSelect> {
  try {
    // Check if user already exists
    const [existingUser] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, supabaseUser.id))
      .limit(1);

    if (existingUser) {
      // Update existing user email if needed, but never update the name or avatar
      const needsUpdate = existingUser.email !== supabaseUser.email;

      if (needsUpdate) {
        const [updatedUser] = await db
          .update(schema.users)
          .set({
            email: supabaseUser.email || existingUser.email,
            updatedAt: new Date(),
          })
          .where(eq(schema.users.id, supabaseUser.id))
          .returning();

        return updatedUser || existingUser;
      }

      return existingUser;
    }

    // Create new user
    const now = new Date();

    // Extract username from email (everything before @)
    const emailUsername = supabaseUser.email?.split('@')[0] || 'User';

    // Get USD token ID as default base currency
    const [usdToken] = await db
      .select({ id: schema.tokens.id })
      .from(schema.tokens)
      .where(eq(schema.tokens.symbol, 'USD'))
      .limit(1);

    const userData = {
      id: supabaseUser.id, // Use Supabase user ID
      email: supabaseUser.email || '',
      name: emailUsername, // Use email prefix as username
      avatar: supabaseUser.user_metadata?.avatar_url || null,
      baseCurrencyId: usdToken?.id || null, // Use USD token ID or null if not found
      createdAt: now,
      updatedAt: now,
    };

    const [newUser] = await db.insert(schema.users).values(userData).returning();

    if (!newUser) {
      throw new Error('Failed to create user in database');
    }

    return newUser;
  } catch (error) {
    authLogger.error(
      {
        error: error instanceof Error ? { name: error.name, message: error.message } : error,
      },
      'Error syncing user with database'
    );
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to sync user data',
    });
  }
}

/**
 * Extracts and validates the JWT token from the Authorization header
 */
export async function createAuthContext(opts: CreateContextOptions): Promise<AuthContext> {
  const authHeader = opts.req.headers.get('authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {
      user: null,
      isAuthenticated: false,
      dbUser: null,
    };
  }

  const token = authHeader.substring(7); // Remove "Bearer " prefix

  try {
    let user: User | null = null;
    let verificationSource: 'local' | 'remote' | 'none' = 'none';
    let localVerificationError: Error | null = null;

    if (SUPABASE_JWT_SECRET) {
      const localResult = verifyTokenLocally(token);
      if (localResult.user) {
        user = localResult.user;
        verificationSource = 'local';
        authLogger.debug({ userId: user.id }, 'Authenticated via local JWT verification');
      } else {
        localVerificationError = localResult.error;
      }
    } else {
      authLogger.warn(
        'SUPABASE_JWT_SECRET not configured - local JWT verification disabled. Set SUPABASE_JWT_SECRET or SUPABASE_SERVICE_ROLE_KEY environment variable.'
      );
    }

    // Verify the JWT token with Supabase
    if (!user) {
      const remoteStartTime = Date.now();
      const {
        data: { user: remoteUser },
        error,
      } = await supabase.auth.getUser(token);
      const remoteDuration = Date.now() - remoteStartTime;

      if (error || !remoteUser) {
        authLogger.warn(
          {
            error: error?.message,
            remoteDuration: `${remoteDuration}ms`,
            localVerificationFailed: localVerificationError !== null,
            localError: localVerificationError
              ? { name: localVerificationError.name, message: localVerificationError.message }
              : undefined,
          },
          'Supabase token verification failed'
        );
        return {
          user: null,
          isAuthenticated: false,
          dbUser: null,
        };
      }

      user = remoteUser;
      verificationSource = 'remote';

      if (localVerificationError) {
        authLogger.info(
          {
            userId: user.id,
            remoteDuration: `${remoteDuration}ms`,
            localError: {
              name: localVerificationError.name,
              message: localVerificationError.message,
            },
          },
          `Local JWT verification failed but remote verification succeeded (${remoteDuration}ms). Consider checking JWT secret configuration.`
        );
      }
    }

    if (!user) {
      return {
        user: null,
        isAuthenticated: false,
        dbUser: null,
      };
    }

    // Sync user with database
    const dbUser = await syncUserWithDatabase(user);

    authLogger.debug(
      {
        userId: user.id,
        verificationSource,
      },
      'User authenticated successfully'
    );

    return {
      user,
      isAuthenticated: true,
      dbUser,
    };
  } catch (error) {
    authLogger.error(
      {
        error: error instanceof Error ? { name: error.name, message: error.message } : error,
      },
      'Auth verification error'
    );
    return {
      user: null,
      isAuthenticated: false,
      dbUser: null,
    };
  }
}

function verifyTokenLocally(token: string): { user: User | null; error: Error | null } {
  if (!SUPABASE_JWT_SECRET) {
    return { user: null, error: null };
  }

  try {
    const payload = jwt.verify(token, SUPABASE_JWT_SECRET, {
      algorithms: ['HS256'],
    }) as JwtPayload & {
      email?: string;
      phone?: string;
      role?: string;
      user_metadata?: Record<string, unknown>;
      app_metadata?: Record<string, unknown>;
      is_anonymous?: boolean;
      identities?: User['identities'];
      factors?: User['factors'];
    };

    if (!payload.sub) {
      return {
        user: null,
        error: new Error('JWT payload missing subject (sub) claim'),
      };
    }

    return { user: buildUserFromPayload(payload), error: null };
  } catch (error) {
    const verificationError = error instanceof Error ? error : new Error(String(error));

    authLogger.debug(
      {
        error: { name: verificationError.name, message: verificationError.message },
        jwtSecretConfigured: !!SUPABASE_JWT_SECRET,
        jwtSecretLength: SUPABASE_JWT_SECRET ? SUPABASE_JWT_SECRET.length : 0,
      },
      'Local JWT verification failed - will fallback to remote Supabase verification'
    );

    return { user: null, error: verificationError };
  }
}

function buildUserFromPayload(payload: JwtPayload & { email?: string; phone?: string }): User {
  const nowIso = new Date().toISOString();
  const issuedAtIso =
    typeof payload.iat === 'number' ? new Date(payload.iat * 1000).toISOString() : nowIso;

  return {
    id: payload.sub ?? '',
    email: payload.email ?? undefined,
    phone: payload.phone ?? undefined,
    app_metadata: (payload.app_metadata as Record<string, unknown>) ?? {},
    user_metadata: (payload.user_metadata as Record<string, unknown>) ?? {},
    aud: (payload.aud as string) ?? 'authenticated',
    created_at: (payload.created_at as string) ?? issuedAtIso,
    updated_at: (payload.updated_at as string) ?? nowIso,
    last_sign_in_at: (payload.last_sign_in_at as string) ?? nowIso,
    role: (payload.role as string | undefined) ?? undefined,
    identities: payload.identities ?? [],
    factors: payload.factors ?? [],
    is_anonymous: payload.is_anonymous ?? false,
    expires_at: typeof payload.exp === 'number' ? payload.exp : undefined,
  } as User;
}

/**
 * Middleware to ensure user is authenticated
 */
export function requireAuth(ctx: AuthContext) {
  if (!ctx.isAuthenticated || !ctx.user || !ctx.dbUser) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
  }

  return {
    supabaseUser: ctx.user,
    dbUser: ctx.dbUser,
  };
}
