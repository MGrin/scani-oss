/**
 * Transfer-review router (SC-150).
 *
 * Its own router rather than three procedures on `review`, for the reason
 * that router's doc gives: the feed is a read-model and an item's actions
 * live with the record that owns them. The record here is a
 * `holding_transactions` row, and this is its surface.
 */

import { TransferReviewService } from '@scani/domain/services';
import { transferReviewDecisionSchema, transferReviewSplitSchema } from '@scani/shared';
import { TRPCError } from '@trpc/server';
import Container from 'typedi';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';

const resolveInput = z
  .object({
    transactionId: z.string().uuid(),
    decision: transferReviewDecisionSchema,
    /** Required for `paired` and meaningless otherwise — checked here rather
     *  than left to the service so a malformed call fails at the boundary. */
    matchTransactionId: z.string().uuid().optional(),
  })
  .refine((v) => v.decision !== 'paired' || Boolean(v.matchTransactionId), {
    message: 'Pairing a transfer requires the matching deposit',
    path: ['matchTransactionId'],
  });

export const transferReviewRouter = router({
  listPending: protectedProcedure.query(async ({ ctx }) =>
    Container.get(TransferReviewService).listPending(ctx.userId)
  ),

  /**
   * A NOT_FOUND here covers "not yours", "not an outflow" and "already
   * answered" alike. The last is the common one — two tabs on the same queue
   * — and it is not a failure: the question really is gone. The client
   * refetches on error, so the row simply disappears.
   */
  resolve: protectedProcedure.input(resolveInput).mutation(async ({ ctx, input }) => {
    const ok = await Container.get(TransferReviewService).resolve(
      ctx.userId,
      input.transactionId,
      input.decision,
      input.matchTransactionId
    );
    if (!ok) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'That transfer is no longer waiting for review',
      });
    }
    return { ok };
  }),

  /**
   * The same question, answered about parts of the transaction (SC-181).
   *
   * Its own procedure rather than an optional field on `resolve`, because the
   * two inputs have nothing in common past the transaction id: one carries a
   * decision and maybe a partner, the other carries a list of amounts whose
   * sum is the thing being checked. Folding them together would produce an
   * input where half the fields are conditionally meaningless and a refine
   * chain nobody can read.
   *
   * **The sum is enforced here, not only in the form.** The shape rules live
   * in `transferReviewSplitSchema` at this boundary; the arithmetic one needs
   * the row, so it runs inside the service's transaction against the very
   * quantity being divided. A 400 carrying the expected total is the useful
   * failure — the reader typed two numbers and one of them is wrong.
   */
  resolveSplit: protectedProcedure
    .input(
      z.object({
        transactionId: z.string().uuid(),
        split: transferReviewSplitSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await Container.get(TransferReviewService).resolveSplit(
        ctx.userId,
        input.transactionId,
        input.split
      );
      if (result.ok) return { ok: true };
      switch (result.reason) {
        case 'gone':
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'That transfer is no longer waiting for review',
          });
        case 'partner_gone':
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'That deposit is already linked to another transfer',
          });
        case 'sum':
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `The parts must add up to ${result.expected}`,
          });
        default:
          throw new TRPCError({ code: 'BAD_REQUEST', message: result.message });
      }
    }),

  listAnswered: protectedProcedure.query(async ({ ctx }) =>
    Container.get(TransferReviewService).listAnswered(ctx.userId)
  ),

  reopen: protectedProcedure
    .input(z.object({ transactionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const ok = await Container.get(TransferReviewService).reopen(ctx.userId, input.transactionId);
      if (!ok) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That transfer has not been reviewed' });
      }
      return { ok };
    }),
});
