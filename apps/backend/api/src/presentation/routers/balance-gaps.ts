/**
 * Balance-gap router (SC-501).
 *
 * Its own router rather than procedures on `review`, for the reason that
 * router's doc gives: the feed is a read-model and an item's actions live
 * with the record that owns them. The record here is a
 * `holding_balance_observations` row — the closing half of a pair whose
 * difference the ledger cannot explain — and this is its surface.
 */

import { BalanceGapAnswerRejected, BalanceGapService } from '@scani/domain/services';
import { ReconcilePaymentsUseCase } from '@scani/domain/use-cases';
import { createComponentLogger } from '@scani/logging';
import { answerBalanceGapSchema } from '@scani/shared';
import { TRPCError } from '@trpc/server';
import Container from 'typedi';
import { z } from 'zod';
import { enqueuePortfolioRollup } from '../lib/portfolio-rollup';
import { strictInput } from '../lib/strict-input';
import { protectedProcedure, router } from '../trpc';

const logger = createComponentLogger('router:balance-gaps');

export const balanceGapsRouter = router({
  crossCurrencyDestinations: protectedProcedure
    .input(strictInput(z.object({ holdingId: z.string().uuid() })))
    .query(({ ctx, input }) =>
      Container.get(BalanceGapService).crossCurrencyDestinations(ctx.userId, input.holdingId)
    ),
  listAnswered: protectedProcedure.query(({ ctx }) =>
    Container.get(BalanceGapService).listAnswered(ctx.userId)
  ),
  undo: protectedProcedure
    .input(strictInput(z.object({ observationId: z.string().uuid() })))
    .mutation(async ({ ctx, input }) => {
      const undone = await Container.get(BalanceGapService).undo(ctx.userId, input.observationId);
      if (undone) await enqueuePortfolioRollup(ctx.userId);
      return { undone };
    }),
  /**
   * The queue, with its own accounting attached.
   *
   * `examined` and `suppressed` travel to the client rather than staying in a
   * log line, because "we looked at 258 changes and are asking about 37" is
   * the sentence that makes a short list trustworthy. A queue that shows only
   * what survived cannot be told apart from one whose query missed rows, and
   * the person best placed to notice the difference is the one who knows what
   * happened to their own money.
   */
  listPending: protectedProcedure.query(async ({ ctx }) =>
    Container.get(BalanceGapService).listPending(ctx.userId)
  ),

  /**
   * Record what the change was.
   *
   * The three refusals are kept apart on purpose. "Already answered" is the
   * ordinary two-tabs case and is not a failure; "no longer a gap" means an
   * import landed the transaction that explains it, which is the system
   * working and worth saying so; "gone" is the holding itself disappearing.
   * Collapsing them into one NOT_FOUND would tell somebody their answer was
   * rejected without telling them the ledger had answered it first.
   */
  answer: protectedProcedure
    .input(strictInput(answerBalanceGapSchema))
    .mutation(async ({ ctx, input }) => {
      const outcome = await Container.get(BalanceGapService)
        .answer(ctx.userId, {
          observationId: input.observationId,
          answer: input.answer,
          editOutflow: input.editOutflow,
          receivedQuantity: input.receivedQuantity,
          parts: input.parts,
          ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
        })
        .catch((error: unknown) => {
          if (error instanceof BalanceGapAnswerRejected)
            throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
          throw error;
        });

      if ('refusal' in outcome) {
        switch (outcome.refusal) {
          case 'already-answered':
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'That balance change has already been explained',
            });
          case 'no-longer-a-gap':
            throw new TRPCError({
              code: 'CONFLICT',
              message:
                'A transaction has since arrived that explains that change, so there is nothing left to record',
            });
          default:
            throw new TRPCError({ code: 'NOT_FOUND', message: 'That holding is no longer there' });
        }
      }

      // A full rebuild until the Neon falsifier proves a range for this edit (SC-1607).
      await enqueuePortfolioRollup(ctx.userId);
      // A flow row can pay a bill, so it is matched now rather than by hand
      // (SC-1665). The answer is saved either way.
      if (outcome.result.wroteKind === 'deposit' || outcome.result.wroteKind === 'withdraw') {
        await Container.get(ReconcilePaymentsUseCase)
          .execute(ctx.userId)
          .catch((error: unknown) =>
            logger.warn(
              { userId: ctx.userId, err: error instanceof Error ? error.message : String(error) },
              'Matching a gap answer to bills failed'
            )
          );
      }
      return outcome.result;
    }),
});
