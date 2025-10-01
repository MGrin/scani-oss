import type { User } from '@supabase/supabase-js';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { supabase } from '../lib/supabase';
import { authLogger } from '../utils/logger';

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

    if (SUPABASE_JWT_SECRET) {
      user = verifyTokenLocally(token);
      if (user) {
        verificationSource = 'local';
        authLogger.debug({ userId: user.id }, 'Authenticated via local JWT verification');
      }
    }

    // Verify the JWT token with Supabase
    if (!user) {
      const {
        data: { user: remoteUser },
        error,
      } = await supabase.auth.getUser(token);

      if (error || !remoteUser) {
        authLogger.warn(
          {
            error: error?.message,
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

function verifyTokenLocally(token: string): User | null {
  if (!SUPABASE_JWT_SECRET) {
    return null;
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
      return null;
    }

    return buildUserFromPayload(payload);
  } catch (error) {
    authLogger.debug(
      {
        error: error instanceof Error ? { name: error.name, message: error.message } : error,
      },
      'Local JWT verification failed, falling back to Supabase'
    );
    return null;
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

/**
 * Get user ID from context, throwing if not authenticated
 */
export function getUserId(ctx: AuthContext): string {
  const { dbUser } = requireAuth(ctx);
  return dbUser.id;
}

/**
 * Get database user from context, throwing if not authenticated
 */
export function getDbUser(ctx: AuthContext): typeof schema.users.$inferSelect {
  const { dbUser } = requireAuth(ctx);
  return dbUser;
}
