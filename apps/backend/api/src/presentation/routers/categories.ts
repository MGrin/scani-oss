/**
 * Categories tRPC router (SC-1652)
 *
 * A person's own transaction categories, one level of nesting. Every call is
 * scoped to the session's user; a category id that is not theirs reads as
 * missing.
 */

import {
  CategoryConflictError,
  CategoryDepthError,
  CategoryNameError,
  CategoryNotFoundError,
  TransactionCategoryService,
} from '@scani/domain/services';
import { SUGGESTED_CATEGORY_KEYS } from '@scani/shared';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { strictInput } from '../lib/strict-input';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const Color = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i)
  .nullable();

/** The client sends the starter set already translated, one name per key. */
const SuggestedNames = z.object(
  Object.fromEntries(SUGGESTED_CATEGORY_KEYS.map((key) => [key, z.string().min(1).max(60)]))
);

async function refusalsAsTrpc<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CategoryConflictError) {
      throw new TRPCError({ code: 'CONFLICT', message: error.message });
    }
    if (error instanceof CategoryDepthError || error instanceof CategoryNameError) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
    }
    if (error instanceof CategoryNotFoundError) {
      throw new TRPCError({ code: 'NOT_FOUND', message: error.message });
    }
    throw error;
  }
}

const service = () => Container.get(TransactionCategoryService);

export const categoriesRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await service().list(dbUser.id);
  }),

  create: protectedProcedure
    .input(
      strictInput(
        z.object({
          name: z.string().min(1).max(60),
          parentId: z.string().uuid().nullish(),
          color: Color.optional(),
        })
      )
    )
    .mutation(async ({ ctx, input }) => {
      const { dbUser } = await requireAuth(ctx);
      return await refusalsAsTrpc(() => service().create(dbUser.id, input));
    }),

  update: protectedProcedure
    .input(
      strictInput(
        z.object({
          id: z.string().uuid(),
          name: z.string().min(1).max(60).optional(),
          parentId: z.string().uuid().nullish(),
          color: Color.optional(),
        })
      )
    )
    .mutation(async ({ ctx, input }) => {
      const { dbUser } = await requireAuth(ctx);
      const { id, ...patch } = input;
      await refusalsAsTrpc(() => service().update(dbUser.id, id, patch));
      return { ok: true as const };
    }),

  delete: protectedProcedure
    .input(
      strictInput(z.object({ id: z.string().uuid(), replacementId: z.string().uuid().optional() }))
    )
    .mutation(async ({ ctx, input }) => {
      const { dbUser } = await requireAuth(ctx);
      return await refusalsAsTrpc(() => service().remove(dbUser.id, input.id, input.replacementId));
    }),

  suggest: protectedProcedure
    .input(strictInput(z.object({ names: SuggestedNames })))
    .mutation(async ({ ctx, input }) => {
      const { dbUser } = await requireAuth(ctx);
      const names = input.names as Record<string, string>;
      return await refusalsAsTrpc(() => service().suggest(dbUser.id, (key) => names[key] ?? key));
    }),
});
