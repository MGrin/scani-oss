/**
 * Transactions tRPC router
 *
 * Over `holding_transactions`, scoped to the authenticated user by the
 * repository query itself. Rows are written by the ingesters and come and
 * go with their deduplication key; the one thing a person writes here is
 * a row's category (SC-1652).
 */

import { withTransaction } from '@scani/db/transaction';
import {
  HoldingTransactionRepository,
  TransactionsNotFoundError,
} from '@scani/domain/repositories';
import { LearnedCategoryRules } from '@scani/domain/services';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { strictInput } from '../lib/strict-input';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const ListInput = z.object({
  holdingId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  tokenId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  kinds: z.array(z.string()).optional(),
  source: z.string().optional(),
  search: z.string().max(100).optional(),
  category: z
    .union([z.object({ id: z.string().uuid() }), z.literal('uncategorized'), z.literal('auto')])
    .optional(),
  limit: z.number().int().positive().max(500).default(100),
  offset: z.number().int().nonnegative().default(0),
  /** The offset under the name `useInfiniteQuery` passes it as. Wins over `offset`. */
  cursor: z.number().int().nonnegative().nullish(),
});

export const transactionsRouter = router({
  list: protectedProcedure.input(strictInput(ListInput)).query(async ({ ctx, input }) => {
    const { dbUser } = await requireAuth(ctx);
    const repo = Container.get(HoldingTransactionRepository);
    const rows = await repo.findByRange({
      userId: dbUser.id,
      holdingId: input.holdingId,
      accountId: input.accountId,
      tokenId: input.tokenId,
      from: input.from,
      to: input.to,
      kinds: input.kinds,
      source: input.source,
      search: input.search,
      category: input.category,
      limit: input.limit,
      offset: input.cursor ?? input.offset,
      order: 'desc',
    });
    const offset = input.cursor ?? input.offset;
    return {
      transactions: rows,
      nextCursor: rows.length === input.limit ? offset + input.limit : null,
    };
  }),

  setCategory: protectedProcedure
    .input(
      strictInput(
        z.object({
          ids: z.array(z.string().uuid()).min(1).max(500),
          categoryId: z.string().uuid().nullable(),
        })
      )
    )
    .mutation(async ({ ctx, input }) => {
      const { dbUser } = await requireAuth(ctx);
      try {
        // The pick and its spread to the same payees land together (SC-1695).
        // One indexed statement for the picked payees only: 3-5 ms on 4,301
        // rows, so it stays in the request.
        return await withTransaction(async (tx) => {
          const { updated } = await Container.get(HoldingTransactionRepository).setCategory(
            dbUser.id,
            input.ids,
            input.categoryId,
            tx
          );
          const spread = await Container.get(LearnedCategoryRules).spreadFrom(
            dbUser.id,
            tx,
            input.ids,
            input.categoryId
          );
          return { updated, spread };
        });
      } catch (error) {
        if (error instanceof TransactionsNotFoundError) {
          throw new TRPCError({ code: 'NOT_FOUND', message: error.message });
        }
        throw error;
      }
    }),

  /** Keep: the automatic categories on these rows become the person's (SC-1695). */
  confirmCategory: protectedProcedure
    .input(strictInput(z.object({ ids: z.array(z.string().uuid()).min(1).max(500) })))
    .mutation(async ({ ctx, input }) => {
      const { dbUser } = await requireAuth(ctx);
      try {
        return await Container.get(HoldingTransactionRepository).confirmCategories(
          dbUser.id,
          input.ids
        );
      } catch (error) {
        if (error instanceof TransactionsNotFoundError) {
          throw new TRPCError({ code: 'NOT_FOUND', message: error.message });
        }
        throw error;
      }
    }),
});
