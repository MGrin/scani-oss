/**
 * A transfer still in transit 7 days after it left (SC-1675): the question
 * Review asks about each destination it went to (SC-1684), and its four answers. Arrived, lost and came back move money
 * from the day it left, so they rebuild history from that day; still waiting
 * moves nothing.
 */

import { type TransitAnswerResult, TransitReviewService } from '@scani/domain/services';
import { TRPCError } from '@trpc/server';
import Container from 'typedi';
import { z } from 'zod';
import { enqueuePortfolioRollup } from '../lib/portfolio-rollup';
import { strictInput } from '../lib/strict-input';
import { protectedProcedure, router } from '../trpc';

const part = { outflowId: z.string().uuid(), destinationHoldingId: z.string().uuid() };

const keyOf = (input: { outflowId: string; destinationHoldingId: string }) => ({
  outflowId: input.outflowId,
  destinationHoldingId: input.destinationHoldingId,
});

async function settled(userId: string, result: TransitAnswerResult, moved: boolean) {
  if (!result.ok) {
    if (result.reason === 'gone') {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'That transfer is no longer travelling' });
    }
    throw new TRPCError({
      code: 'CONFLICT',
      message:
        result.reason === 'not_candidate'
          ? 'That transaction cannot be this transfer'
          : 'This transfer cannot be answered that way',
    });
  }
  if (moved) await enqueuePortfolioRollup(userId, result.sentAt.toISOString().slice(0, 10));
  return { ok: true as const };
}

export const transitReviewRouter = router({
  listDue: protectedProcedure.query(({ ctx }) =>
    Container.get(TransitReviewService).listDue(ctx.userId)
  ),

  candidates: protectedProcedure
    .input(strictInput(z.object(part)))
    .query(({ ctx, input }) =>
      Container.get(TransitReviewService).candidates(ctx.userId, keyOf(input))
    ),

  arrived: protectedProcedure
    .input(strictInput(z.object({ ...part, inflowId: z.string().uuid() })))
    .mutation(async ({ ctx, input }) =>
      settled(
        ctx.userId,
        await Container.get(TransitReviewService).arrived(ctx.userId, keyOf(input), input.inflowId),
        true
      )
    ),

  lost: protectedProcedure
    .input(strictInput(z.object({ ...part, decision: z.enum(['fee', 'left_control']) })))
    .mutation(async ({ ctx, input }) =>
      settled(
        ctx.userId,
        await Container.get(TransitReviewService).lost(ctx.userId, keyOf(input), input.decision),
        true
      )
    ),

  cameBack: protectedProcedure
    .input(strictInput(z.object({ ...part, refundId: z.string().uuid() })))
    .mutation(async ({ ctx, input }) =>
      settled(
        ctx.userId,
        await Container.get(TransitReviewService).cameBack(
          ctx.userId,
          keyOf(input),
          input.refundId
        ),
        true
      )
    ),

  stillWaiting: protectedProcedure
    .input(strictInput(z.object(part)))
    .mutation(async ({ ctx, input }) =>
      settled(
        ctx.userId,
        await Container.get(TransitReviewService).stillWaiting(ctx.userId, keyOf(input)),
        false
      )
    ),
});
