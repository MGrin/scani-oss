import { CreateHoldingSchema, UpdateHoldingSchema } from '@scani/shared/types';
import { and, desc, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { getUserId, requireAuth } from '../middleware/auth';
import { PricingService } from '../services/pricing';
import { protectedProcedure, router } from '../trpc';

export const holdingsRouter = router({
  // Get all holdings
  getAll: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = requireAuth(ctx);

    const holdings = await db
      .select()
      .from(schema.holdings)
      .where(eq(schema.holdings.userId, dbUser.id))
      .orderBy(desc(schema.holdings.lastUpdated));
    return holdings;
  }),

  // Check if holding already exists (for duplicate prevention)
  checkDuplicate: protectedProcedure
    .input(
      z.object({
        accountId: z.string(),
        tokenId: z.string(),
        excludeId: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const conditions = [
        eq(schema.holdings.accountId, input.accountId),
        eq(schema.holdings.tokenId, input.tokenId),
      ];

      // Exclude current holding when editing (use NOT EQUAL)
      if (input.excludeId) {
        conditions.push(ne(schema.holdings.id, input.excludeId));
      }

      const [existingHolding] = await db
        .select()
        .from(schema.holdings)
        .where(and(...conditions))
        .limit(1);

      return {
        exists: !!existingHolding,
        holding: existingHolding || null,
      };
    }),

  // Create new holding
  create: protectedProcedure
    .input(
      CreateHoldingSchema.omit({ lastUpdated: true }).extend({
        lastUpdated: z.date().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = requireAuth(ctx);
      const userId = dbUser.id;
      const now = new Date();

      // Validate account existence
      const [account] = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, input.accountId))
        .limit(1);

      if (!account) {
        throw new Error('Account does not exist for the specified accountId');
      }

      // Validate token existence
      const [token] = await db
        .select()
        .from(schema.tokens)
        .where(eq(schema.tokens.id, input.tokenId))
        .limit(1);

      if (!token) {
        throw new Error('Token does not exist for the specified tokenId');
      }

      // Use database transaction to ensure atomicity
      return await db.transaction(async (trx) => {
        const holdingData = {
          ...input,
          userId,
          balance: input.balance || '0', // Ensure balance is always a string
          createdAt: now,
          lastUpdated: input.lastUpdated || now, // Always ensure lastUpdated is set
        };

        const [holding] = await trx.insert(schema.holdings).values(holdingData).returning();

        if (!holding) {
          throw new Error('Failed to create holding');
        }

        // Fetch current token price for the user's base currency
        try {
          // Use cached user data instead of querying database
          if (dbUser.baseCurrencyId) {
            const [baseCurrency] = await trx
              .select()
              .from(schema.tokens)
              .where(eq(schema.tokens.id, dbUser.baseCurrencyId))
              .limit(1);

            if (baseCurrency && token.symbol !== baseCurrency.symbol) {
              const pricingService = new PricingService();
              await pricingService.getTokenPrice({
                tokenSymbol: token.symbol,
                baseCurrency: baseCurrency.symbol,
                timestamp: now,
                live: true, // Get current price for new holdings
              });
              console.log(`Fetched current price for ${token.symbol}/${baseCurrency.symbol}`);
            }
          }
        } catch (error) {
          console.warn(`Failed to fetch price for ${token.symbol}:`, error);
          // Continue without price - holding can still be created
        }

        // Create opening balance transaction if balance > 0
        if (parseFloat(holding.balance) > 0) {
          // Get the deposit transaction type
          const [depositType] = await trx
            .select()
            .from(schema.transactionTypes)
            .where(
              and(
                eq(schema.transactionTypes.code, 'deposit'),
                eq(schema.transactionTypes.isActive, true)
              )
            )
            .limit(1);

          if (!depositType) {
            throw new Error('Deposit transaction type not found');
          }

          await trx.insert(schema.transactions).values({
            userId,
            holdingId: holding.id,
            typeId: depositType.id, // Use typeId instead of type
            amount: holding.balance, // Already a string
            fee: '0', // Convert fee to string
            description: 'Opening balance - initial holding position',
            timestamp: now,
            createdAt: now,
            updatedAt: now,
          });
        }

        return holding;
      });
    }),

  // Update holding
  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        data: UpdateHoldingSchema,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);
      const updateData = {
        ...input.data,
        lastUpdated: input.data.lastUpdated || new Date(),
      };

      const [updatedHolding] = await db
        .update(schema.holdings)
        .set(updateData)
        .where(and(eq(schema.holdings.id, input.id), eq(schema.holdings.userId, userId)))
        .returning();

      if (!updatedHolding) {
        throw new Error('Holding not found');
      }

      return updatedHolding;
    }),

  // Delete holding
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = requireAuth(ctx);

      const [deletedHolding] = await db
        .delete(schema.holdings)
        .where(and(eq(schema.holdings.id, input.id), eq(schema.holdings.userId, dbUser.id)))
        .returning();

      if (!deletedHolding) {
        throw new Error('Holding not found');
      }

      return { success: true, deleted: deletedHolding };
    }),
});
