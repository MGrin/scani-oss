import { UpdateUserSchema } from '@scani/shared/types';
import { eq } from 'drizzle-orm';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { getUserId, requireAuth } from '../middleware/auth';
import { PortfolioValuationService } from '../services/portfolio-valuation';
import { protectedProcedure, router } from '../trpc';

export const usersRouter = router({
  // Get current authenticated user
  getCurrent: protectedProcedure.query(async ({ ctx }) => {
    // Use cached user data from auth context instead of querying database
    const { dbUser } = requireAuth(ctx);
    return dbUser;
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

  // Get user's base currency token (lightweight)
  getBaseCurrency: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = requireAuth(ctx);

    if (!dbUser.baseCurrencyId) {
      return null;
    }

    const [baseCurrency] = await db
      .select({
        id: schema.tokens.id,
        symbol: schema.tokens.symbol,
        name: schema.tokens.name,
      })
      .from(schema.tokens)
      .where(eq(schema.tokens.id, dbUser.baseCurrencyId))
      .limit(1);

    return baseCurrency || null;
  }),

  // Get current portfolio value
  getPortfolioValue: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = requireAuth(ctx);
    const portfolioService = new PortfolioValuationService();

    try {
      // Pass user's base currency ID to avoid extra database query
      return await portfolioService.getUserPortfolioValue(
        dbUser.id,
        dbUser.baseCurrencyId || undefined
      );
    } catch (error) {
      // If error occurs (e.g., no base currency), return empty portfolio
      console.warn(`Failed to get portfolio value for user ${dbUser.id}:`, error);
      return {
        totalValue: 0,
        baseCurrency: 'USD',
        holdings: [],
      };
    }
  }),
});
