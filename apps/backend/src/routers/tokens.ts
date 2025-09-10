import { CreateTokenSchema, TokenType, UpdateTokenSchema } from '@scani/shared/types';
import { and, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { publicProcedure, router } from '../trpc';

// Type assertion for router operations (development/test environment uses SQLite)
const routerDb = db as ReturnType<typeof import('drizzle-orm/bun-sqlite').drizzle>;

export const tokensRouter = router({
  // Get all active tokens
  getAll: publicProcedure.query(async () => {
    const tokens = await routerDb
      .select()
      .from(schema.tokens)
      .where(eq(schema.tokens.isActive, true))
      .orderBy(schema.tokens.symbol);
    return tokens;
  }),

  // Get tokens by type
  getByType: publicProcedure.input(z.object({ type: TokenType })).query(async ({ input }) => {
    const tokens = await routerDb
      .select()
      .from(schema.tokens)
      .where(and(eq(schema.tokens.type, input.type), eq(schema.tokens.isActive, true)))
      .orderBy(schema.tokens.symbol);
    return tokens;
  }),

  // Get token by ID
  getById: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const [token] = await routerDb
      .select()
      .from(schema.tokens)
      .where(eq(schema.tokens.id, input.id))
      .limit(1);

    if (!token) {
      throw new Error('Token not found');
    }
    return token;
  }),

  // Get token by symbol
  getBySymbol: publicProcedure.input(z.object({ symbol: z.string() })).query(async ({ input }) => {
    const [token] = await routerDb
      .select()
      .from(schema.tokens)
      .where(eq(schema.tokens.symbol, input.symbol.toUpperCase()))
      .limit(1);

    if (!token) {
      throw new Error('Token not found');
    }
    return token;
  }),

  // Create new token
  create: publicProcedure.input(CreateTokenSchema).mutation(async ({ input }) => {
    // Check if symbol already exists
    const [existingToken] = await routerDb
      .select()
      .from(schema.tokens)
      .where(eq(schema.tokens.symbol, input.symbol.toUpperCase()))
      .limit(1);

    if (existingToken) {
      throw new Error('Token with this symbol already exists');
    }

    const now = new Date();
    const tokenData = {
      id: nanoid(),
      ...input,
      symbol: input.symbol.toUpperCase(), // Ensure symbols are uppercase
      createdAt: now,
      updatedAt: now,
    };

    const [createdToken] = await routerDb.insert(schema.tokens).values(tokenData).returning();

    if (!createdToken) {
      throw new Error('Failed to create token');
    }

    return createdToken;
  }),

  // Update token
  update: publicProcedure
    .input(
      z.object({
        id: z.string(),
        data: UpdateTokenSchema,
      })
    )
    .mutation(async ({ input }) => {
      // If updating symbol, check for uniqueness
      if (input.data.symbol) {
        const [existingToken] = await routerDb
          .select()
          .from(schema.tokens)
          .where(
            and(
              eq(schema.tokens.symbol, input.data.symbol.toUpperCase()),
              // Exclude current token from uniqueness check
              sql`${schema.tokens.id} != ${input.id}`
            )
          )
          .limit(1);

        if (existingToken) {
          throw new Error('Token with this symbol already exists');
        }
      }

      const updateData = {
        ...input.data,
        ...(input.data.symbol && { symbol: input.data.symbol.toUpperCase() }),
        updatedAt: new Date(),
      };

      const [updatedToken] = await routerDb
        .update(schema.tokens)
        .set(updateData)
        .where(eq(schema.tokens.id, input.id))
        .returning();

      if (!updatedToken) {
        throw new Error('Token not found');
      }

      return updatedToken;
    }),

  // Delete token (soft delete by setting isActive to false)
  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const [deletedToken] = await routerDb
      .update(schema.tokens)
      .set({
        isActive: false,
        updatedAt: new Date(),
      })
      .where(eq(schema.tokens.id, input.id))
      .returning();

    if (!deletedToken) {
      throw new Error('Token not found');
    }

    return { success: true, deleted: deletedToken };
  }),
});
