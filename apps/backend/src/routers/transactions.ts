import { UpdateTransactionSchema } from '@scani/shared/types';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { getUserId } from '../middleware/auth';
import { PricingService } from '../services/pricing';
import { protectedProcedure, router } from '../trpc';

// Type assertion for router operations (development/test environment uses SQLite)
const routerDb = db as ReturnType<typeof import('drizzle-orm/postgres-js').drizzle>;

export const transactionsRouter = router({
  // Get all transactions
  getAll: protectedProcedure.query(async () => {
    const transactions = await routerDb
      .select({
        id: schema.transactions.id,
        holdingId: schema.transactions.holdingId,
        typeId: schema.transactions.typeId,
        type: schema.transactionTypes.code,
        typeName: schema.transactionTypes.name,
        amount: schema.transactions.amount,
        fee: schema.transactions.fee,
        feeTokenId: schema.transactions.feeTokenId,
        description: schema.transactions.description,
        reference: schema.transactions.reference,
        timestamp: schema.transactions.timestamp,
        createdAt: schema.transactions.createdAt,
        updatedAt: schema.transactions.updatedAt,
      })
      .from(schema.transactions)
      .innerJoin(
        schema.transactionTypes,
        eq(schema.transactions.typeId, schema.transactionTypes.id)
      )
      .orderBy(desc(schema.transactions.timestamp));
    return transactions;
  }),

  // Get transactions by holding ID
  getByHoldingId: protectedProcedure
    .input(z.object({ holdingId: z.string() }))
    .query(async ({ input }) => {
      const transactions = await routerDb
        .select({
          id: schema.transactions.id,
          holdingId: schema.transactions.holdingId,
          typeId: schema.transactions.typeId,
          type: schema.transactionTypes.code,
          typeName: schema.transactionTypes.name,
          amount: schema.transactions.amount,
          fee: schema.transactions.fee,
          feeTokenId: schema.transactions.feeTokenId,
          description: schema.transactions.description,
          reference: schema.transactions.reference,
          timestamp: schema.transactions.timestamp,
          createdAt: schema.transactions.createdAt,
          updatedAt: schema.transactions.updatedAt,
        })
        .from(schema.transactions)
        .innerJoin(
          schema.transactionTypes,
          eq(schema.transactions.typeId, schema.transactionTypes.id)
        )
        .where(eq(schema.transactions.holdingId, input.holdingId))
        .orderBy(desc(schema.transactions.timestamp));
      return transactions;
    }),

  // Get transactions by type
  getByType: protectedProcedure
    .input(z.object({ type: z.string(), holdingId: z.string().optional() }))
    .query(async ({ input }) => {
      const whereConditions = [eq(schema.transactionTypes.code, input.type)];
      if (input.holdingId) {
        whereConditions.push(eq(schema.transactions.holdingId, input.holdingId));
      }

      const query = routerDb
        .select({
          id: schema.transactions.id,
          holdingId: schema.transactions.holdingId,
          typeId: schema.transactions.typeId,
          type: schema.transactionTypes.code,
          typeName: schema.transactionTypes.name,
          amount: schema.transactions.amount,
          fee: schema.transactions.fee,
          feeTokenId: schema.transactions.feeTokenId,
          description: schema.transactions.description,
          reference: schema.transactions.reference,
          timestamp: schema.transactions.timestamp,
          createdAt: schema.transactions.createdAt,
          updatedAt: schema.transactions.updatedAt,
        })
        .from(schema.transactions)
        .innerJoin(
          schema.transactionTypes,
          eq(schema.transactions.typeId, schema.transactionTypes.id)
        )
        .where(whereConditions.length > 1 ? and(...whereConditions) : whereConditions[0]);

      return await query.orderBy(desc(schema.transactions.timestamp));
    }),

  // Get transaction by ID
  getById: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const [transaction] = await routerDb
      .select({
        id: schema.transactions.id,
        holdingId: schema.transactions.holdingId,
        typeId: schema.transactions.typeId,
        type: schema.transactionTypes.code,
        typeName: schema.transactionTypes.name,
        amount: schema.transactions.amount,
        fee: schema.transactions.fee,
        feeTokenId: schema.transactions.feeTokenId,
        description: schema.transactions.description,
        reference: schema.transactions.reference,
        timestamp: schema.transactions.timestamp,
        createdAt: schema.transactions.createdAt,
        updatedAt: schema.transactions.updatedAt,
      })
      .from(schema.transactions)
      .innerJoin(
        schema.transactionTypes,
        eq(schema.transactions.typeId, schema.transactionTypes.id)
      )
      .where(eq(schema.transactions.id, input.id))
      .limit(1);

    if (!transaction) {
      throw new Error('Transaction not found');
    }
    return transaction;
  }),

  // Create new transaction
  create: protectedProcedure
    .input(
      z.object({
        holdingId: z.string().min(1, 'Holding ID cannot be empty'),
        type: z.string().min(1, 'Transaction type cannot be empty'), // This will be the type code
        amount: z.string().default('0'), // Convert to string
        fee: z.string().default('0'), // Convert to string
        feeTokenId: z.string().optional(),
        description: z.string().max(500).optional(),
        reference: z.string().max(100).optional(),
        timestamp: z.date(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);

      // Look up the transaction type by code to get the typeId
      const [transactionType] = await routerDb
        .select()
        .from(schema.transactionTypes)
        .where(
          and(
            eq(schema.transactionTypes.code, input.type),
            eq(schema.transactionTypes.isActive, true)
          )
        )
        .limit(1);

      if (!transactionType) {
        throw new Error(`Invalid transaction type: ${input.type}`);
      }

      // Get holding and token information for pricing
      const [holdingData] = await routerDb
        .select({
          holding: schema.holdings,
          token: schema.tokens,
          user: schema.users,
        })
        .from(schema.holdings)
        .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
        .innerJoin(schema.users, eq(schema.holdings.userId, schema.users.id))
        .where(eq(schema.holdings.id, input.holdingId))
        .limit(1);

      // Get base currency separately if user has one set
      let baseCurrency = null;
      if (holdingData?.user.baseCurrencyId) {
        const [baseCurrencyData] = await routerDb
          .select()
          .from(schema.tokens)
          .where(eq(schema.tokens.id, holdingData.user.baseCurrencyId))
          .limit(1);
        baseCurrency = baseCurrencyData;
      }

      if (!holdingData) {
        throw new Error('Holding not found');
      }

      // Auto-fetch token price for current price tracking (optional)
      if (baseCurrency) {
        try {
          const pricingService = new PricingService();
          await pricingService.getTokenPrice({
            tokenSymbol: holdingData.token.symbol,
            baseCurrency: baseCurrency.symbol,
            timestamp: input.timestamp,
            live: false, // Use historical price for transaction timestamp
          });
          // Price is now cached in tokenPrices table
        } catch (error) {
          console.warn(`Failed to fetch price for ${holdingData.token.symbol}:`, error);
          // Continue without price - transaction can still be created
        }
      }

      const now = new Date();
      const transactionData = {
        userId,
        holdingId: input.holdingId,
        typeId: transactionType.id, // Use the actual typeId
        amount: input.amount || '0', // Already a string
        fee: input.fee || '0', // Already a string
        feeTokenId: input.feeTokenId || null,
        description: input.description || null,
        reference: input.reference || null,
        timestamp: input.timestamp,
        createdAt: now,
        updatedAt: now,
      };

      const [transaction] = await routerDb
        .insert(schema.transactions)
        .values(transactionData)
        .returning();

      if (!transaction) {
        throw new Error('Failed to create transaction');
      }

      // Fetch the transaction with type information
      const [transactionWithType] = await routerDb
        .select({
          id: schema.transactions.id,
          holdingId: schema.transactions.holdingId,
          typeId: schema.transactions.typeId,
          type: schema.transactionTypes.code,
          typeName: schema.transactionTypes.name,
          amount: schema.transactions.amount,
          fee: schema.transactions.fee,
          feeTokenId: schema.transactions.feeTokenId,
          description: schema.transactions.description,
          reference: schema.transactions.reference,
          timestamp: schema.transactions.timestamp,
          createdAt: schema.transactions.createdAt,
          updatedAt: schema.transactions.updatedAt,
        })
        .from(schema.transactions)
        .innerJoin(
          schema.transactionTypes,
          eq(schema.transactions.typeId, schema.transactionTypes.id)
        )
        .where(eq(schema.transactions.id, transaction.id))
        .limit(1);

      if (!transactionWithType) {
        throw new Error('Failed to fetch created transaction');
      }

      return transactionWithType;
    }),

  // Update transaction
  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        data: UpdateTransactionSchema,
      })
    )
    .mutation(async ({ input }) => {
      const updateData = {
        ...input.data,
        // Monetary fields are already strings in the schema
        updatedAt: new Date(),
      };

      const [updatedTransaction] = await routerDb
        .update(schema.transactions)
        .set(updateData)
        .where(eq(schema.transactions.id, input.id))
        .returning();

      if (!updatedTransaction) {
        throw new Error('Transaction not found');
      }

      // Fetch the updated transaction with type information
      const [transactionWithType] = await routerDb
        .select({
          id: schema.transactions.id,
          holdingId: schema.transactions.holdingId,
          typeId: schema.transactions.typeId,
          type: schema.transactionTypes.code,
          typeName: schema.transactionTypes.name,
          amount: schema.transactions.amount,
          fee: schema.transactions.fee,
          feeTokenId: schema.transactions.feeTokenId,
          description: schema.transactions.description,
          reference: schema.transactions.reference,
          timestamp: schema.transactions.timestamp,
          createdAt: schema.transactions.createdAt,
          updatedAt: schema.transactions.updatedAt,
        })
        .from(schema.transactions)
        .innerJoin(
          schema.transactionTypes,
          eq(schema.transactions.typeId, schema.transactionTypes.id)
        )
        .where(eq(schema.transactions.id, updatedTransaction.id))
        .limit(1);

      if (!transactionWithType) {
        throw new Error('Failed to fetch updated transaction');
      }

      return transactionWithType;
    }),

  // Delete transaction
  delete: protectedProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const [deletedTransaction] = await routerDb
      .delete(schema.transactions)
      .where(eq(schema.transactions.id, input.id))
      .returning();

    if (!deletedTransaction) {
      throw new Error('Transaction not found');
    }

    return { success: true, deleted: deletedTransaction };
  }),

  // Get transactions by date range
  getByDateRange: protectedProcedure
    .input(
      z.object({
        startDate: z.date(),
        endDate: z.date(),
        holdingId: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const whereConditions = [
        // Add date range filtering logic here when implementing
        eq(schema.transactions.id, schema.transactions.id), // Placeholder
      ];
      if (input.holdingId) {
        whereConditions.push(eq(schema.transactions.holdingId, input.holdingId));
      }

      const query = routerDb
        .select()
        .from(schema.transactions)
        .where(whereConditions.length > 1 ? and(...whereConditions) : whereConditions[0]);

      return await query.orderBy(desc(schema.transactions.timestamp));
    }),

  // Get transactions with fees above threshold
  getHighFeeTransactions: protectedProcedure
    .input(z.object({ minFee: z.number() }))
    .query(async ({ input }) => {
      return await routerDb
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.fee, input.minFee.toString())) // Convert number to string
        .orderBy(desc(schema.transactions.fee));
    }),
});
