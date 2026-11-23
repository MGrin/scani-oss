import { CategoryRuleError, TransactionCategoryRuleService } from '@scani/domain/services';
import { categoryRuleSaveSchema, categoryRuleScopeSchema } from '@scani/shared';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { strictInput } from '../lib/strict-input';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof CategoryRuleError)) throw error;
    const code =
      error.code === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : [
              'DUPLICATE_RULE',
              'REVISION_CONFLICT',
              'PREVIEW_LIMIT',
              'STALE_PREVIEW',
              'UNDO_CONFLICT',
              'ALREADY_UNDONE',
              'BUSY',
            ].includes(error.code)
          ? 'CONFLICT'
          : 'BAD_REQUEST';
    throw new TRPCError({ code, message: error.code });
  }
}
const service = () => Container.get(TransactionCategoryRuleService);
export const categoryRulesRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return run(() => service().list(dbUser.id));
  }),
  save: protectedProcedure
    .input(strictInput(categoryRuleSaveSchema))
    .mutation(async ({ ctx, input }) => {
      const { dbUser } = await requireAuth(ctx);
      return run(() => service().save(dbUser.id, input));
    }),
  remove: protectedProcedure
    .input(
      strictInput(
        z.object({ id: z.string().uuid(), expectedRevision: z.number().int().positive() })
      )
    )
    .mutation(async ({ ctx, input }) => {
      const { dbUser } = await requireAuth(ctx);
      await run(() => service().remove(dbUser.id, input.id, input.expectedRevision));
      return { ok: true };
    }),
  preview: protectedProcedure
    .input(strictInput(categoryRuleScopeSchema))
    .mutation(async ({ ctx, input }) => {
      const { dbUser } = await requireAuth(ctx);
      return run(() => service().preview(dbUser.id, input));
    }),
  apply: protectedProcedure
    .input(strictInput(z.object({ previewId: z.string().uuid() })))
    .mutation(async ({ ctx, input }) => {
      const { dbUser } = await requireAuth(ctx);
      return run(() => service().apply(dbUser.id, input.previewId));
    }),
  undo: protectedProcedure
    .input(strictInput(z.object({ operationId: z.string().uuid() })))
    .mutation(async ({ ctx, input }) => {
      const { dbUser } = await requireAuth(ctx);
      return run(() => service().undo(dbUser.id, input.operationId));
    }),
  recent: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return run(() => service().recent(dbUser.id));
  }),
});
