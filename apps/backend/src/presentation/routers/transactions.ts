import { UpdateTransactionSchema } from '@scani/shared/types';
import Decimal from 'decimal.js';
import { and, desc, eq, gte, inArray, lte, not } from 'drizzle-orm';
import { Container } from 'typedi';
import { z } from 'zod';
import { PricingService } from '../../application/services/PricingService';
import type { TransactionService } from '../../application/services/TransactionService';
import { UserContextService } from '../../application/services/UserContextService';
import {
  CreateTransactionUseCase,
  DeleteTransactionUseCase,
  UpdateTransactionUseCase,
} from '../../application/use-cases';
import { db } from '../../infrastructure/database/connection';
import * as schema from '../../infrastructure/database/schema';
import type { TransactionRepository } from '../../infrastructure/repositories/TransactionRepository';
import { emitEntityChange } from '../../infrastructure/websocket/RealTimeUpdatesService';
import { getUserId, requireAuth } from '../../middleware/auth';
import { createComponentLogger } from '../../utils/logger';
import { protectedProcedure, router } from '../trpc';

// Type assertion for router operations (development/test environment uses SQLite)
const routerDb = db as ReturnType<typeof import('drizzle-orm/postgres-js').drizzle>;
const transactionsLogger = createComponentLogger('router:transactions');

/**
 * Factory function to create the transactions router with injected dependencies
 * Note: Contains complex pricing logic that should be refactored into service layer
 */
export function createTransactionsRouter(
  _transactionRepository: TransactionRepository,
  _transactionService: TransactionService
) {
  return router({
    // Get all transactions
    getAll: protectedProcedure.query(async ({ ctx }) => {
      const { dbUser } = requireAuth(ctx);

      if (!dbUser.baseCurrencyId) {
        throw new Error('User base currency not found');
      }

      // Use user context service to get base currency efficiently
      const userContextService = Container.get(UserContextService);
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
      const pricingService = Container.get(PricingService);
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
          transactionsLogger.warn(
            {
              transactionId: transaction.id,
              holdingId: transaction.holdingId,
              symbol: transaction.tokenSymbol,
              error: error instanceof Error ? { name: error.name, message: error.message } : error,
            },
            'Failed to convert transaction amount to base currency'
          );
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

    // Get transaction by ID (enforce ownership via holding.userId)
    getById: protectedProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ input, ctx }) => {
        const userId = getUserId(ctx);
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
          .innerJoin(schema.holdings, eq(schema.transactions.holdingId, schema.holdings.id))
          .where(and(eq(schema.transactions.id, input.id), eq(schema.holdings.userId, userId)))
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

        // Use the CreateTransactionUseCase for business logic
        const createTransactionUseCase = Container.get(CreateTransactionUseCase);
        const transaction = await createTransactionUseCase.execute(
          {
            holdingId: input.holdingId,
            typeCode: input.type,
            amount: input.amount,
            fee: input.fee,
            feeTokenId: input.feeTokenId,
            description: input.description,
            reference: input.reference,
            timestamp: input.timestamp,
          },
          userId
        );

        // Optionally fetch and cache token price (non-blocking)
        // Get user's base currency for price fetching
        const userContextService = Container.get(UserContextService);
        try {
          const baseCurrency = await userContextService.getBaseCurrency(userId);
          if (baseCurrency) {
            // Fire and forget price fetching
            createTransactionUseCase
              .fetchTokenPrice(input.holdingId, userId, baseCurrency.symbol, input.timestamp)
              .catch((error) => {
                transactionsLogger.warn(
                  { holdingId: input.holdingId, error },
                  'Failed to fetch token price in background'
                );
              });
          }
        } catch (error) {
          // Ignore errors in price fetching - it's optional
          transactionsLogger.debug({ error }, 'Could not fetch base currency for price tracking');
        }

        // Emit real-time update
        emitEntityChange({
          type: 'entity_changed',
          entityType: 'transaction',
          operationType: 'create',
          entityId: transaction.id,
          userId,
          data: {
            holdingId: transaction.holdingId,
            typeId: transaction.typeId,
            amount: transaction.amount,
            fee: transaction.fee,
            timestamp:
              transaction.timestamp instanceof Date
                ? transaction.timestamp.toISOString()
                : transaction.timestamp,
          },
          metadata: {
            relatedEntities: [
              {
                type: 'holding',
                id: transaction.holdingId,
              },
            ],
          },
        });

        return transaction;
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

        // Use UpdateTransactionUseCase for business logic
        const updateTransactionUseCase = Container.get(UpdateTransactionUseCase);
        const transactionWithType = await updateTransactionUseCase.execute(
          input.id,
          input.data,
          userId
        );

        emitEntityChange({
          type: 'entity_changed',
          entityType: 'transaction',
          operationType: 'update',
          entityId: transactionWithType.id,
          userId,
          data: {
            holdingId: transactionWithType.holdingId,
            typeId: transactionWithType.typeId,
            type: transactionWithType.type,
            amount: transactionWithType.amount,
            fee: transactionWithType.fee,
            timestamp:
              transactionWithType.timestamp instanceof Date
                ? transactionWithType.timestamp.toISOString()
                : transactionWithType.timestamp,
            updatedAt:
              transactionWithType.updatedAt instanceof Date
                ? transactionWithType.updatedAt.toISOString()
                : transactionWithType.updatedAt,
          },
          metadata: {
            relatedEntities: [
              {
                type: 'holding',
                id: transactionWithType.holdingId,
              },
            ],
          },
        });

        return transactionWithType;
      }),

    // Delete transaction
    delete: protectedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input, ctx }) => {
        const userId = getUserId(ctx);

        // Use the DeleteTransactionUseCase for business logic
        const deleteTransactionUseCase = Container.get(DeleteTransactionUseCase);
        const result = await deleteTransactionUseCase.execute(input.id, userId);

        // Emit real-time update
        emitEntityChange({
          type: 'entity_changed',
          entityType: 'transaction',
          operationType: 'delete',
          entityId: result.deletedTransaction.id,
          userId,
          data: {
            holdingId: result.holdingId,
            typeId: result.deletedTransaction.typeId,
            timestamp:
              result.deletedTransaction.timestamp instanceof Date
                ? result.deletedTransaction.timestamp.toISOString()
                : result.deletedTransaction.timestamp,
          },
          metadata: {
            relatedEntities: [
              {
                type: 'holding',
                id: result.holdingId,
              },
            ],
          },
        });

        return {
          success: result.success,
          deleted: result.deletedTransaction,
          holdingBalanceUpdated: true,
          newBalance: result.newBalance,
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
        const userContextService = Container.get(UserContextService);
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
        const pricingService = Container.get(PricingService);
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
            transactionsLogger.warn(
              {
                transactionId: transaction.id,
                holdingId: transaction.holdingId,
                symbol: transaction.tokenSymbol,
                error:
                  error instanceof Error ? { name: error.name, message: error.message } : error,
              },
              'Failed to convert transaction amount to base currency'
            );
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
}

// Legacy export for backwards compatibility
// biome-ignore lint/suspicious/noExplicitAny: Temporary null export for backwards compatibility during migration
export const transactionsRouter = null as any;
