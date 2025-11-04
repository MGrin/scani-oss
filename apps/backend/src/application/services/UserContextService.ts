import type { User } from '@supabase/supabase-js';
import { eq } from 'drizzle-orm';
import { Service } from 'typedi';
import { db } from '../../infrastructure/database/connection';
import * as schema from '../../infrastructure/database/schema';

// Types for better type safety
export interface Token {
  id: string;
  symbol: string;
  name: string;
}

@Service()
export class UserContextService {
  /**
   * Get user's base currency token with optimized query
   * Replaces repeated queries in PortfolioValuationService
   */
  async getBaseCurrency(userId: string): Promise<Token> {
    // Fetch user and base currency in a single optimized query
    const [userWithBaseCurrency] = await db
      .select({
        userId: schema.users.id,
        baseCurrencyId: schema.tokens.id,
        baseCurrencySymbol: schema.tokens.symbol,
        baseCurrencyName: schema.tokens.name,
      })
      .from(schema.users)
      .innerJoin(schema.tokens, eq(schema.users.baseCurrencyId, schema.tokens.id))
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (!userWithBaseCurrency) {
      throw new Error(`User ${userId} not found or has no base currency set`);
    }

    return {
      id: userWithBaseCurrency.baseCurrencyId,
      symbol: userWithBaseCurrency.baseCurrencySymbol,
      name: userWithBaseCurrency.baseCurrencyName,
    };
  }

  /**
   * Get user by ID
   */
  async getUserById(userId: string): Promise<typeof schema.users.$inferSelect | null> {
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);

    return user || null;
  }

  /**
   * Creates or updates a user in the database based on Supabase user data
   */
  async getOrCreateUser(supabaseUser: User): Promise<typeof schema.users.$inferSelect> {
    try {
      // Check if user already exists
      const [existingUser] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, supabaseUser.id))
        .limit(1);

      if (existingUser) {
        // Update existing user email if needed
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
      throw new Error(
        `Failed to sync user data: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}
