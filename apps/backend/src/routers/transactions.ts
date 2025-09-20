import { UpdateTransactionSchema } from '@scani/shared/types';
import Decimal from 'decimal.js';
import { and, desc, eq, gte, inArray, lte, not } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { getUserId, requireAuth } from '../middleware/auth';
import { pricingService } from '../services/pricing';
import { userContextService } from '../services/user-context-enhanced';
import { protectedProcedure, router } from '../trpc';

// Type assertion for router operations (development/test environment uses SQLite)
const routerDb = db as ReturnType<typeof import('drizzle-orm/postgres-js').drizzle>;

export const transactionsRouter = router({
  // Get all transactions
  getAll: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = requireAuth(ctx);

    if (!dbUser.baseCurrencyId) {
      throw new Error('User base currency not found');
    }

    // Use user context service to get base currency efficiently
    const baseCurrency = await userContextService.getBaseCurrency(dbUser.id);
    const baseCurrencySymbol = baseCurrency.symbol;

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
        tokenId: schema.tokens.id,
        tokenSymbol: schema.tokens.symbol,
      })
      .from(schema.transactions)
      .innerJoin(
        schema.transactionTypes,
        eq(schema.transactions.typeId, schema.transactionTypes.id)
      )
      .innerJoin(schema.holdings, eq(schema.transactions.holdingId, schema.holdings.id))
      .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
      .where(eq(schema.holdings.userId, dbUser.id))
      .orderBy(desc(schema.transactions.timestamp));

    // PERFORMANCE OPTIMIZATION: Batch fetch all prices at once
    // Use singleton pricing service

    // Get unique token symbols that need pricing (excluding base currency)
    const tokenSymbolsToPrice = [
      ...new Set(
        transactions
          .filter((transaction) => transaction.tokenSymbol !== baseCurrencySymbol)
          .map((transaction) => transaction.tokenSymbol)
      ),
    ];

    // Get full token objects for pricing service
    const tokensToPrice =
      tokenSymbolsToPrice.length > 0
        ? await db
            .select()
            .from(schema.tokens)
            .where(inArray(schema.tokens.symbol, tokenSymbolsToPrice))
        : [];

    // Fetch all prices at once using the latest timestamp for all tokens
    const priceResults =
      tokensToPrice.length > 0
        ? await pricingService.getTokenPrices(tokensToPrice, baseCurrencySymbol, new Date())
        : new Map<string, string>();

    // Convert amounts to base currency using batched price data
    const transactionsWithConversion = transactions.map((transaction) => {
      try {
        let baseCurrencyAmount: string;
        let baseCurrencyFee: string = '0';

        // Convert transaction amount to base currency
        if (transaction.tokenSymbol === baseCurrencySymbol) {
          // Same currency, no conversion needed
          baseCurrencyAmount = transaction.amount;
        } else {
          // Use batched price result - find token ID first
          const token = tokensToPrice.find((t) => t.symbol === transaction.tokenSymbol);
          const price = token ? priceResults.get(token.id) || '0' : '0';
          const amount = new Decimal(transaction.amount || '0');
          baseCurrencyAmount = amount.mul(new Decimal(price)).toString();
        }

        // Convert fee if it exists (assuming fee is always in base currency for now)
        if (parseFloat(transaction.fee) > 0) {
          baseCurrencyFee = transaction.fee;
        }

        return {
          ...transaction,
          baseCurrencyAmount,
          baseCurrencyFee,
          baseCurrencySymbol,
        };
      } catch (error) {
        console.warn(`Failed to convert transaction ${transaction.id} to base currency:`, error);
        // Return original transaction with same amounts if conversion fails
        return {
          ...transaction,
          baseCurrencyAmount: transaction.amount,
          baseCurrencyFee: transaction.fee,
          baseCurrencySymbol,
        };
      }
    });

    return transactionsWithConversion;
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
          await pricingService.getTokenPrice(
            holdingData.token,
            baseCurrency.symbol,
            input.timestamp
          );
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
    .mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);

      // First verify the transaction belongs to the user by checking holding ownership
      const [transactionOwnership] = await routerDb
        .select({ id: schema.transactions.id })
        .from(schema.transactions)
        .innerJoin(schema.holdings, eq(schema.transactions.holdingId, schema.holdings.id))
        .where(and(eq(schema.transactions.id, input.id), eq(schema.holdings.userId, userId)))
        .limit(1);

      if (!transactionOwnership) {
        throw new Error('Transaction not found');
      }
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
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);

      // First get the transaction to get the holding ID for balance recalculation
      const [transaction] = await routerDb
        .select({
          id: schema.transactions.id,
          holdingId: schema.transactions.holdingId,
        })
        .from(schema.transactions)
        .innerJoin(schema.holdings, eq(schema.transactions.holdingId, schema.holdings.id))
        .where(and(eq(schema.transactions.id, input.id), eq(schema.holdings.userId, userId)))
        .limit(1);

      if (!transaction) {
        throw new Error('Transaction not found');
      }

      const [deletedTransaction] = await routerDb
        .delete(schema.transactions)
        .where(eq(schema.transactions.id, input.id))
        .returning();

      if (!deletedTransaction) {
        throw new Error('Failed to delete transaction');
      }

      // Recalculate holding balance after transaction deletion
      const { holdingManagementService } = await import('../services/holding-management');
      await holdingManagementService.updateHoldingBalance(transaction.holdingId);

      return {
        success: true,
        deleted: deletedTransaction,
        holdingBalanceUpdated: true,
      };
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

  // Get monthly transaction summaries (deposits, withdrawals, net flow)
  getMonthlySummary: protectedProcedure
    .input(
      z.object({
        year: z.number().optional(),
        month: z.number().optional(), // 0-11 (JavaScript month index)
      })
    )
    .query(async ({ input, ctx }) => {
      const { dbUser } = requireAuth(ctx);

      // Default to current month if not specified
      const now = new Date();
      const targetYear = input.year ?? now.getFullYear();
      const targetMonth = input.month ?? now.getMonth();

      // Create date range for the target month
      const startOfMonth = new Date(targetYear, targetMonth, 1);
      const endOfMonth = new Date(targetYear, targetMonth + 1, 0, 23, 59, 59);

      if (!dbUser.baseCurrencyId) {
        return {
          year: targetYear,
          month: targetMonth,
          totalDeposits: 0,
          totalWithdrawals: 0,
          netFlow: 0,
          transactionCount: 0,
        };
      }

      // Get base currency token using user context service
      const baseCurrency = await userContextService.getBaseCurrency(dbUser.id);

      if (!baseCurrency) {
        return {
          year: targetYear,
          month: targetMonth,
          totalDeposits: 0,
          totalWithdrawals: 0,
          netFlow: 0,
          transactionCount: 0,
        };
      }

      // Get transactions in date range for user's holdings with token information
      // Exclude opening balance transactions from monthly aggregations
      const transactions = await routerDb
        .select({
          id: schema.transactions.id,
          holdingId: schema.transactions.holdingId,
          amount: schema.transactions.amount,
          type: schema.transactionTypes.code,
          timestamp: schema.transactions.timestamp,
          tokenSymbol: schema.tokens.symbol,
          tokenId: schema.tokens.id,
        })
        .from(schema.transactions)
        .innerJoin(
          schema.transactionTypes,
          eq(schema.transactions.typeId, schema.transactionTypes.id)
        )
        .innerJoin(schema.holdings, eq(schema.transactions.holdingId, schema.holdings.id))
        .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
        .where(
          and(
            eq(schema.holdings.userId, dbUser.id),
            gte(schema.transactions.timestamp, startOfMonth),
            lte(schema.transactions.timestamp, endOfMonth),
            // Exclude opening balance transactions from monthly aggregations
            not(eq(schema.transactions.description, 'Opening balance - initial holding position'))
          )
        );

      // PERFORMANCE OPTIMIZATION: Batch fetch all prices at once
      // Use singleton pricing service

      // Get unique token symbols that need pricing (excluding base currency)
      const tokenSymbolsToPrice = [
        ...new Set(
          transactions
            .filter((transaction) => transaction.tokenId !== dbUser.baseCurrencyId)
            .map((transaction) => transaction.tokenSymbol)
        ),
      ];

      // Get full token objects for pricing service
      const tokensToPrice =
        tokenSymbolsToPrice.length > 0
          ? await db
              .select()
              .from(schema.tokens)
              .where(inArray(schema.tokens.symbol, tokenSymbolsToPrice))
          : [];

      // Fetch all prices at once using the latest timestamp for all tokens
      const priceResults =
        tokensToPrice.length > 0
          ? await pricingService.getTokenPrices(tokensToPrice, baseCurrency.symbol, new Date())
          : new Map<string, string>();

      // Calculate summaries in base currency using batched price data
      let totalDeposits = new Decimal(0);
      let totalWithdrawals = new Decimal(0);

      for (const transaction of transactions) {
        try {
          const amount = new Decimal(transaction.amount || '0');

          // Convert amount to base currency
          let convertedAmount: Decimal;
          if (transaction.tokenId === dbUser.baseCurrencyId) {
            // Same currency, no conversion needed
            convertedAmount = amount;
          } else {
            // Use batched price result - find token ID first
            const token = tokensToPrice.find((t) => t.symbol === transaction.tokenSymbol);
            const price = token ? priceResults.get(token.id) || '0' : '0';
            convertedAmount = amount.mul(new Decimal(price));
          }

          if (transaction.type === 'deposit') {
            totalDeposits = totalDeposits.add(convertedAmount.abs());
          } else if (transaction.type === 'withdrawal') {
            totalWithdrawals = totalWithdrawals.add(convertedAmount.abs());
          }
        } catch (error) {
          console.warn(`Failed to convert transaction ${transaction.id} to base currency:`, error);
          // Skip this transaction if price conversion fails
        }
      }

      return {
        year: targetYear,
        month: targetMonth,
        totalDeposits: parseFloat(totalDeposits.toString()),
        totalWithdrawals: parseFloat(totalWithdrawals.toString()),
        netFlow: parseFloat(totalDeposits.sub(totalWithdrawals).toString()),
        transactionCount: transactions.length,
      };
    }),
});
