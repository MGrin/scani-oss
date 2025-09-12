import { UpdateUserSchema } from '@scani/shared/types';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { getUserId } from '../middleware/auth';
import { PortfolioValuationService } from '../services/portfolio-valuation';
import { protectedProcedure, router } from '../trpc';

export const usersRouter = router({
  // Get current authenticated user
  getCurrent: protectedProcedure.query(async ({ ctx }) => {
    const userId = getUserId(ctx);

    const [user] = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        avatar: schema.users.avatar,
        baseCurrencyId: schema.users.baseCurrencyId,
        baseCurrency: {
          id: schema.tokens.id,
          symbol: schema.tokens.symbol,
          name: schema.tokens.name,
        },
        createdAt: schema.users.createdAt,
        updatedAt: schema.users.updatedAt,
      })
      .from(schema.users)
      .leftJoin(schema.tokens, eq(schema.users.baseCurrencyId, schema.tokens.id))
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (!user) {
      throw new Error('User not found');
    }

    return user;
  }),

  // Get all users
  getAll: protectedProcedure.query(async () => {
    const users = await db.select().from(schema.users).orderBy(schema.users.name);
    return users;
  }),

  // Get user by ID
  getById: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, input.id))
      .limit(1);

    if (!user) {
      throw new Error('User not found');
    }
    return user;
  }),

  // Update current user
  updateCurrent: protectedProcedure.input(UpdateUserSchema).mutation(async ({ input, ctx }) => {
    const userId = getUserId(ctx);

    const [updatedUser] = await db
      .update(schema.users)
      .set({
        ...input,
        updatedAt: new Date(),
      })
      .where(eq(schema.users.id, userId))
      .returning();

    if (!updatedUser) {
      throw new Error('User not found');
    }

    return updatedUser;
  }),

  // Delete user
  delete: protectedProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const [deletedUser] = await db
      .delete(schema.users)
      .where(eq(schema.users.id, input.id))
      .returning();

    if (!deletedUser) {
      throw new Error('User not found');
    }

    return { success: true, deleted: deletedUser };
  }),

  // Get supported fiat currencies (tokens) for base currency selection
  getSupportedCurrencies: protectedProcedure.query(async () => {
    const fiatTokens = await db
      .select({
        id: schema.tokens.id,
        symbol: schema.tokens.symbol,
        name: schema.tokens.name,
      })
      .from(schema.tokens)
      .leftJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
      .where(eq(schema.tokenTypes.code, 'fiat'))
      .orderBy(schema.tokens.name);

    return fiatTokens;
  }),

  // Get current portfolio value
  getPortfolioValue: protectedProcedure.query(async ({ ctx }) => {
    const userId = getUserId(ctx);
    const portfolioService = new PortfolioValuationService();

    try {
      return await portfolioService.getUserPortfolioValue(userId);
    } catch (error) {
      // If error occurs (e.g., no base currency), return empty portfolio
      console.warn(`Failed to get portfolio value for user ${userId}:`, error);
      return {
        totalValue: 0,
        baseCurrency: 'USD',
        holdings: [],
      };
    }
  }),
});
