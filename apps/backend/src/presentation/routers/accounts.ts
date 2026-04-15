import { AccountImplementations } from '@scani/core/features/implementations';
import { IdInputDto, UpdateAccountDto } from '@scani/shared';
import { z } from 'zod';
import {
  emitBulkEntityChanges,
  emitEntityChange,
} from '../../infrastructure/websocket/RealTimeUpdatesService';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

export const accountsRouter = router({
  getAll: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await AccountImplementations.getAll({ userId: dbUser.id, dbUser }, {});
  }),

  getByUserIdWithSummary: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await AccountImplementations.getByUserIdWithSummary({ userId: dbUser.id, dbUser }, {});
  }),

  getById: protectedProcedure.input(IdInputDto).query(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await AccountImplementations.getById({ userId: dbUser.id, dbUser }, { id: input.id });
  }),

  getHoldings: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        includeHidden: z.boolean().optional().default(false),
      })
    )
    .query(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      return await AccountImplementations.getHoldings(
        { userId: dbUser.id, dbUser },
        { id: input.id, includeHidden: input.includeHidden }
      );
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        data: UpdateAccountDto,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const result = await AccountImplementations.update(
        { userId: dbUser.id, dbUser },
        { id: input.id, data: input.data }
      );

      emitEntityChange({
        type: 'entity_changed',
        entityType: 'account',
        operationType: 'update',
        entityId: input.id,
        userId: dbUser.id,
        data: result,
      });

      return result;
    }),

  delete: protectedProcedure.input(IdInputDto).mutation(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);

    const result = await AccountImplementations.delete(
      { userId: dbUser.id, dbUser },
      { id: input.id }
    );

    emitEntityChange({
      type: 'entity_changed',
      entityType: 'account',
      operationType: 'delete',
      entityId: input.id,
      userId: dbUser.id,
      data: {},
    });

    return result;
  }),

  bulkDelete: protectedProcedure
    .input(z.object({ ids: z.array(z.string()).min(1) }))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const result = await AccountImplementations.bulkDelete(
        { userId: dbUser.id, dbUser },
        { ids: input.ids }
      );

      // PERFORMANCE: Emit single bulk event instead of looping
      if (result.deletedIds.length > 0) {
        emitBulkEntityChanges('account', 'delete', result.deletedIds, dbUser.id);
      }

      return result;
    }),

  bulkAssignGroups: protectedProcedure
    .input(
      z.object({
        accountIds: z.array(z.string()).min(1),
        // Diff-based like `holdings.bulkAssignGroups` — see that
        // procedure for the rationale. Under the current model, an
        // account is "in" a group iff all of its visible holdings are
        // in that group. Assigning a group to an account adds that
        // group to every visible holding of the account; removing a
        // group from an account removes that group from every visible
        // holding. `accountGroups` is then recomputed as a cache.
        addedGroupIds: z.array(z.string()).default([]),
        removedGroupIds: z.array(z.string()).default([]),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const result = await AccountImplementations.bulkAssignGroups(
        { userId: dbUser.id, dbUser },
        {
          accountIds: input.accountIds,
          addedGroupIds: input.addedGroupIds,
          removedGroupIds: input.removedGroupIds,
        }
      );

      // PERFORMANCE: Emit single bulk event instead of looping
      if (input.accountIds.length > 0) {
        emitBulkEntityChanges('account', 'update', input.accountIds, dbUser.id);
      }

      return result;
    }),

  getCommonGroups: protectedProcedure
    .input(z.object({ accountIds: z.array(z.string()).min(1) }))
    .query(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const result = await AccountImplementations.getCommonGroups(
        { userId: dbUser.id, dbUser },
        { accountIds: input.accountIds }
      );

      return result;
    }),
});
