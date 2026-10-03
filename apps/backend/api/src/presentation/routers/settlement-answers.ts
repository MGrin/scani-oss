/**
 * Balance-gap answers that imported trade settlements now explain (SC-1453).
 *
 * The owner decides per answer: Retire takes its rows out of the ledger and
 * keeps a full copy for Undo, Keep leaves it and stops asking. Nothing here
 * retires an answer on its own (SC-858).
 */

import { SettlementAnswerReviewService } from '@scani/domain/services';
import { TRPCError } from '@trpc/server';
import Container from 'typedi';
import { z } from 'zod';
import { enqueuePortfolioRollup } from '../lib/portfolio-rollup';
import { strictInput } from '../lib/strict-input';
import { protectedProcedure, router } from '../trpc';

export const settlementAnswersRouter = router({
  listPending: protectedProcedure.query(({ ctx }) =>
    Container.get(SettlementAnswerReviewService).listPending(ctx.userId)
  ),

  retire: protectedProcedure
    .input(
      strictInput(
        z.object({
          observationId: z.string().uuid(),
          confirmOtherHolding: z.boolean().optional(),
        })
      )
    )
    .mutation(async ({ ctx, input }) => {
      const outcome = await Container.get(SettlementAnswerReviewService).retire(
        ctx.userId,
        input.observationId,
        { confirmOtherHolding: input.confirmOtherHolding }
      );
      if ('refusal' in outcome) {
        switch (outcome.refusal) {
          case 'moves-another-holding':
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message:
                'This answer also moved money on another holding. Confirm to retire it there too',
            });
          case 'linked-elsewhere':
            throw new TRPCError({
              code: 'CONFLICT',
              message:
                'This answer is linked to another transaction, so it cannot be retired here. Undo it from the balance review instead',
            });
          case 'not-redundant':
            throw new TRPCError({
              code: 'CONFLICT',
              message:
                'Imported trades no longer explain this answer, so there is nothing to retire',
            });
          default:
            throw new TRPCError({ code: 'NOT_FOUND', message: 'That answer is no longer there' });
        }
      }
      await enqueuePortfolioRollup(ctx.userId);
      return outcome.retired;
    }),

  keep: protectedProcedure
    .input(strictInput(z.object({ observationId: z.string().uuid() })))
    .mutation(async ({ ctx, input }) => {
      const kept = await Container.get(SettlementAnswerReviewService).keep(
        ctx.userId,
        input.observationId
      );
      if (!kept)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That answer is no longer there' });
      return { kept };
    }),

  undoRetire: protectedProcedure
    .input(strictInput(z.object({ retiredId: z.string().uuid() })))
    .mutation(async ({ ctx, input }) => {
      const outcome = await Container.get(SettlementAnswerReviewService).undoRetire(
        ctx.userId,
        input.retiredId
      );
      if ('refusal' in outcome) {
        switch (outcome.refusal) {
          case 'answered-since':
            throw new TRPCError({
              code: 'CONFLICT',
              message:
                'That balance change has been answered again since. Undo the newer answer first',
            });
          case 'holding-gone':
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'The holding this answer was on is no longer there',
            });
          case 'already-restored':
            throw new TRPCError({ code: 'CONFLICT', message: 'That answer is already back' });
          default:
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Nothing to undo' });
        }
      }
      await enqueuePortfolioRollup(ctx.userId);
      return outcome.restored;
    }),
});
