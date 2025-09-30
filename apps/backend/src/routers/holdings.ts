import { CreateHoldingSchema, UpdateHoldingSchema } from '@scani/shared/types';
import { and, desc, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { getUserId, requireAuth } from '../middleware/auth';
import { portfolioValuationService } from '../services/portfolio-valuation';
import { pricingService } from '../services/pricing';
import { emitEntityChange } from '../services/real-time-updates';
import { protectedProcedure, router } from '../trpc';
import { createComponentLogger } from '../utils/logger';

const holdingsLogger = createComponentLogger('router:holdings');

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

  getById: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ input, ctx }) => {
    const { dbUser } = requireAuth(ctx);

    const [holding] = await db
      .select({
        id: schema.holdings.id,
        accountId: schema.holdings.accountId,
        tokenId: schema.holdings.tokenId,
        tokenSymbol: schema.tokens.symbol,
        tokenName: schema.tokens.name,
      })
      .from(schema.holdings)
      .leftJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
      .where(and(eq(schema.holdings.id, input.id), eq(schema.holdings.userId, dbUser.id)))
      .limit(1);

    return holding ?? null;
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
    .query(async ({ input, ctx }) => {
      const { dbUser } = requireAuth(ctx);
      const userId = dbUser.id;

      const conditions = [
        eq(schema.holdings.userId, userId), // Add user scoping
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

      holdingsLogger.debug(
        {
          userId,
          input,
        },
        'Creating holding'
      );

      // Validate account existence and ownership
      const [account] = await db
        .select()
        .from(schema.accounts)
        .where(and(eq(schema.accounts.id, input.accountId), eq(schema.accounts.userId, userId)))
        .limit(1);

      if (!account) {
        throw new Error('Account does not exist or does not belong to the current user');
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
      const holding = await db.transaction(async (trx) => {
        const holdingData = {
          ...input,
          userId,
          balance: input.balance || '0', // Ensure balance is always a string
          createdAt: now,
          lastUpdated: input.lastUpdated || now, // Always ensure lastUpdated is set
        };

        holdingsLogger.debug(
          {
            userId,
            accountId: holdingData.accountId,
            tokenId: holdingData.tokenId,
          },
          'Inserting holding data'
        );
        const [holding] = await trx.insert(schema.holdings).values(holdingData).returning();

        if (!holding) {
          throw new Error('Failed to create holding');
        }

        holdingsLogger.debug(
          {
            holdingId: holding.id,
            accountId: holding.accountId,
          },
          'Holding created successfully'
        );

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
              await pricingService.getTokenPrice(token, baseCurrency.symbol, now);
              holdingsLogger.debug(
                {
                  tokenId: token.id,
                  symbol: token.symbol,
                  baseCurrency: baseCurrency.symbol,
                },
                'Fetched current price after holding creation'
              );
            }
          }
        } catch (error) {
          holdingsLogger.warn(
            {
              tokenId: token.id,
              symbol: token.symbol,
              error: error instanceof Error ? { name: error.name, message: error.message } : error,
            },
            'Failed to fetch token price during holding creation'
          );
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

      if (holding) {
        emitEntityChange({
          type: 'entity_changed',
          entityType: 'holding',
          operationType: 'create',
          entityId: holding.id,
          userId,
          data: {
            accountId: holding.accountId,
            tokenId: holding.tokenId,
          },
        });
      }

      return holding;
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

      emitEntityChange({
        type: 'entity_changed',
        entityType: 'holding',
        operationType: 'update',
        entityId: updatedHolding.id,
        userId,
        data: {
          accountId: updatedHolding.accountId,
          tokenId: updatedHolding.tokenId,
        },
      });

      return updatedHolding;
    }),

  // Delete holding (with cascading to transactions)
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = requireAuth(ctx);

      // Get transaction count for logging purposes before deletion
      const transactions = await db
        .select({ id: schema.transactions.id })
        .from(schema.transactions)
        .where(eq(schema.transactions.holdingId, input.id));

      // Delete the holding - cascading deletes will handle transactions
      const [deletedHolding] = await db
        .delete(schema.holdings)
        .where(and(eq(schema.holdings.id, input.id), eq(schema.holdings.userId, dbUser.id)))
        .returning();

      if (!deletedHolding) {
        throw new Error('Holding not found');
      }

      emitEntityChange({
        type: 'entity_changed',
        entityType: 'holding',
        operationType: 'delete',
        entityId: deletedHolding.id,
        userId: dbUser.id,
        metadata: {
          relatedEntities: [
            {
              type: 'account',
              id: deletedHolding.accountId,
            },
          ],
        },
        data: {
          cascadeInfo: {
            transactionsDeleted: transactions.length,
          },
        },
      });

      return {
        success: true,
        deleted: deletedHolding,
        cascadeInfo: {
          transactionsDeleted: transactions.length,
        },
      };
    }),

  // Get unpriceable tokens for monetization notification
  getUnpriceableTokens: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = requireAuth(ctx);
    return await portfolioValuationService.getUnpriceableTokens(dbUser.id);
  }),
});
