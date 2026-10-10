/**
 * "Was this the transfer to <account>?" (SC-1696): money the owner answered
 * `untracked` whose same amount later arrived in an account Scani tracks. Yes
 * pairs the two through the queue's own `paired` answer, so history rebuilds
 * from the day it left; no keeps the answer and moves nothing.
 */

import {
  type UntrackedArrivalAnswerResult,
  UntrackedArrivalReviewService,
} from '@scani/domain/services';
import { TRPCError } from '@trpc/server';
import Container from 'typedi';
import { z } from 'zod';
import { enqueuePortfolioRollup } from '../lib/portfolio-rollup';
import { strictInput } from '../lib/strict-input';
import { protectedProcedure, router } from '../trpc';

const keyInput = strictInput(
  z.object({ outflowId: z.string().uuid(), inflowId: z.string().uuid() })
);

async function settled(userId: string, result: UntrackedArrivalAnswerResult, moved: boolean) {
  if (!result.ok) {
    if (result.reason === 'gone') {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'That question is no longer asked' });
    }
    throw new TRPCError({ code: 'CONFLICT', message: 'Those two cannot be linked' });
  }
  if (moved) await enqueuePortfolioRollup(userId, result.sentAt.toISOString().slice(0, 10));
  return { ok: true as const };
}

export const untrackedArrivalReviewRouter = router({
  listDue: protectedProcedure.query(({ ctx }) =>
    Container.get(UntrackedArrivalReviewService).listDue(ctx.userId)
  ),

  confirm: protectedProcedure.input(keyInput).mutation(async ({ ctx, input }) =>
    settled(
      ctx.userId,
      await Container.get(UntrackedArrivalReviewService).confirm(ctx.userId, {
        outflowId: input.outflowId,
        inflowId: input.inflowId,
      }),
      true
    )
  ),

  decline: protectedProcedure.input(keyInput).mutation(async ({ ctx, input }) =>
    settled(
      ctx.userId,
      await Container.get(UntrackedArrivalReviewService).decline(ctx.userId, {
        outflowId: input.outflowId,
        inflowId: input.inflowId,
      }),
      false
    )
  ),
});
