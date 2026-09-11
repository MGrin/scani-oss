/**
 * Transactions tRPC router
 *
 * Read-only over `holding_transactions`, scoped to the authenticated
 * user by the repository query itself. Rows are written by the
 * ingesters and come and go with their deduplication key.
 */

import { HoldingTransactionRepository } from '@scani/domain/repositories';
import { Container } from 'typedi';
import { z } from 'zod';
import { strictInput } from '../lib/strict-input';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const ListInput = z.object({
  accountId: z.string().uuid().optional(),
  tokenId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  kinds: z.array(z.string()).optional(),
  source: z.string().optional(),
  limit: z.number().int().positive().max(500).default(100),
  offset: z.number().int().nonnegative().default(0),
});

export const transactionsRouter = router({
  list: protectedProcedure.input(strictInput(ListInput)).query(async ({ ctx, input }) => {
    const { dbUser } = await requireAuth(ctx);
    const repo = Container.get(HoldingTransactionRepository);
    const rows = await repo.findByRange({
      userId: dbUser.id,
      accountId: input.accountId,
      tokenId: input.tokenId,
      from: input.from,
      to: input.to,
      kinds: input.kinds,
      source: input.source,
      limit: input.limit,
      offset: input.offset,
      order: 'desc',
    });
    return { transactions: rows };
  }),
});
