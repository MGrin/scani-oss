/**
 * Balance-gap router (SC-501).
 *
 * Its own router rather than procedures on `review`, for the reason that
 * router's doc gives: the feed is a read-model and an item's actions live
 * with the record that owns them. The record here is a
 * `holding_balance_observations` row — the closing half of a pair whose
 * difference the ledger cannot explain — and this is its surface.
 */

import { BalanceGapService } from '@scani/domain/services';
import { answerBalanceGapSchema } from '@scani/shared';
import { TRPCError } from '@trpc/server';
import Container from 'typedi';
import { strictInput } from '../lib/strict-input';
import { protectedProcedure, router } from '../trpc';

export const balanceGapsRouter = router({
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
      const outcome = await Container.get(BalanceGapService).answer(ctx.userId, {
        observationId: input.observationId,
        answer: input.answer,
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
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

      return outcome.result;
    }),
});
