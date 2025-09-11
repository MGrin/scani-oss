import { CreateHoldingSchema, UpdateHoldingSchema } from '@scani/shared/types';
import { and, desc, eq, ne } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { getUserId } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

export const holdingsRouter = router({
  // Get all holdings
  getAll: protectedProcedure.query(async () => {
    const holdings = await db
      .select()
      .from(schema.holdings)
      .orderBy(desc(schema.holdings.lastUpdated));
    return holdings;
  }),

  // Get holdings by account ID
  getByAccountId: protectedProcedure
    .input(z.object({ accountId: z.string() }))
    .query(async ({ input }) => {
      const holdings = await db
        .select()
        .from(schema.holdings)
        .where(eq(schema.holdings.accountId, input.accountId))
        .orderBy(desc(schema.holdings.lastUpdated));
      return holdings;
    }),

  // Get holdings by token ID
  getByTokenId: protectedProcedure
    .input(z.object({ tokenId: z.string() }))
    .query(async ({ input }) => {
      const holdings = await db
        .select()
        .from(schema.holdings)
        .where(eq(schema.holdings.tokenId, input.tokenId))
        .orderBy(desc(schema.holdings.lastUpdated));
      return holdings;
    }),

  // Get holding by account and token
  getByAccountAndToken: protectedProcedure
    .input(z.object({ accountId: z.string(), tokenId: z.string() }))
    .query(async ({ input }) => {
      const [holding] = await db
        .select()
        .from(schema.holdings)
        .where(
          and(
            eq(schema.holdings.accountId, input.accountId),
            eq(schema.holdings.tokenId, input.tokenId)
          )
        )
        .limit(1);

      if (!holding) {
        throw new Error('Holding not found');
      }
      return holding;
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
  // Get holding by ID
  getById: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const [holding] = await db
      .select()
      .from(schema.holdings)
      .where(eq(schema.holdings.id, input.id))
      .limit(1);

    if (!holding) {
      throw new Error('Holding not found');
    }
    return holding;
  }),

  // Create new holding
  create: protectedProcedure
    .input(
      CreateHoldingSchema.omit({ lastUpdated: true }).extend({
        lastUpdated: z.date().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);
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
          id: nanoid(),
          balance: input.balance || 0, // Ensure balance is always a number
          createdAt: now,
          lastUpdated: input.lastUpdated || now, // Always ensure lastUpdated is set
        };

        const [holding] = await trx.insert(schema.holdings).values(holdingData).returning();

        if (!holding) {
          throw new Error('Failed to create holding');
        }

        // Create opening balance transaction if balance > 0
        if (holding.balance > 0) {
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
            id: nanoid(),
            userId,
            holdingId: holding.id,
            typeId: depositType.id, // Use typeId instead of type
            amount: holding.balance,
            price: holding.averageCostBasis || null, // Use cost basis as price if available
            fee: 0,
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
    .mutation(async ({ input }) => {
      const updateData = {
        ...input.data,
        lastUpdated: input.data.lastUpdated || new Date(),
      };

      const [updatedHolding] = await db
        .update(schema.holdings)
        .set(updateData)
        .where(eq(schema.holdings.id, input.id))
        .returning();

      if (!updatedHolding) {
        throw new Error('Holding not found');
      }

      return updatedHolding;
    }),

  // Update holding balance
  updateBalance: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        balance: z.number(),
        averageCostBasis: z.number().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const updateData: Partial<typeof schema.holdings.$inferInsert> = {
        balance: input.balance,
        lastUpdated: new Date(),
      };

      if (input.averageCostBasis !== undefined) {
        updateData.averageCostBasis = input.averageCostBasis;
      }

      const [updatedHolding] = await db
        .update(schema.holdings)
        .set(updateData)
        .where(eq(schema.holdings.id, input.id))
        .returning();

      if (!updatedHolding) {
        throw new Error('Holding not found');
      }

      return updatedHolding;
    }),

  // Delete holding
  delete: protectedProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const [deletedHolding] = await db
      .delete(schema.holdings)
      .where(eq(schema.holdings.id, input.id))
      .returning();

    if (!deletedHolding) {
      throw new Error('Holding not found');
    }

    return { success: true, deleted: deletedHolding };
  }),
});
