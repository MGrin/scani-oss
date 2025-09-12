import type { User } from '@supabase/supabase-js';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { supabase } from '../lib/supabase';

export interface AuthContext {
  user: User | null;
  isAuthenticated: boolean;
  dbUser?: typeof schema.users.$inferSelect | null;
}

export interface CreateContextOptions {
  req: Request;
}

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
      // Update existing user email if needed, but never update the name
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
    console.error('Error syncing user with database:', error);
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
    // Verify the JWT token with Supabase
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user) {
      return {
        user: null,
        isAuthenticated: false,
        dbUser: null,
      };
    }

    // Sync user with database
    const dbUser = await syncUserWithDatabase(user);

    return {
      user,
      isAuthenticated: true,
      dbUser,
    };
  } catch (error) {
    console.error('Auth verification error:', error);
    return {
      user: null,
      isAuthenticated: false,
      dbUser: null,
    };
  }
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
