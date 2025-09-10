import {
  CreateTransactionSchema,
  TransactionType,
  UpdateTransactionSchema,
} from '@scani/shared/types';
import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { publicProcedure, router } from '../trpc';

// Type assertion for router operations (development/test environment uses SQLite)
const routerDb = db as ReturnType<typeof import('drizzle-orm/bun-sqlite').drizzle>;

export const transactionsRouter = router({
  // Get all transactions
  getAll: publicProcedure.query(async () => {
    const transactions = await routerDb
      .select()
      .from(schema.transactions)
      .orderBy(desc(schema.transactions.timestamp));
    return transactions;
  }),

  // Get transactions by holding ID
  getByHoldingId: publicProcedure
    .input(z.object({ holdingId: z.string() }))
    .query(async ({ input }) => {
      const transactions = await routerDb
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.holdingId, input.holdingId))
        .orderBy(desc(schema.transactions.timestamp));
      return transactions;
    }),

  // Get transactions by type
  getByType: publicProcedure
    .input(z.object({ type: TransactionType, holdingId: z.string().optional() }))
    .query(async ({ input }) => {
      const whereConditions = [eq(schema.transactions.type, input.type)];
      if (input.holdingId) {
        whereConditions.push(eq(schema.transactions.holdingId, input.holdingId));
      }

      const query = routerDb
        .select()
        .from(schema.transactions)
        .where(whereConditions.length > 1 ? and(...whereConditions) : whereConditions[0]);

      return await query.orderBy(desc(schema.transactions.timestamp));
    }),

  // Get transaction by ID
  getById: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const [transaction] = await routerDb
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, input.id))
      .limit(1);

    if (!transaction) {
      throw new Error('Transaction not found');
    }
    return transaction;
  }),

  // Create new transaction
  create: publicProcedure.input(CreateTransactionSchema).mutation(async ({ input }) => {
    const now = new Date();
    const transactionData = {
      ...input,
      id: nanoid(),
      amount: input.amount || 0, // Ensure amount is always a number
      createdAt: now,
      updatedAt: now,
    };

    const [transaction] = await routerDb
      .insert(schema.transactions)
      .values(transactionData)
      .returning();

    return transaction;
  }),

  // Update transaction
  update: publicProcedure
    .input(
      z.object({
        id: z.string(),
        data: UpdateTransactionSchema,
      })
    )
    .mutation(async ({ input }) => {
      const updateData = {
        ...input.data,
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

      return updatedTransaction;
    }),

  // Delete transaction
  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
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
  getByDateRange: publicProcedure
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
  getHighFeeTransactions: publicProcedure
    .input(z.object({ minFee: z.number() }))
    .query(async ({ input }) => {
      return await routerDb
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.fee, input.minFee)) // Placeholder - need proper comparison
        .orderBy(desc(schema.transactions.fee));
    }),
});
