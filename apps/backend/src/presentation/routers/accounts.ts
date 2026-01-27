import { AccountImplementations } from '@scani/core/features/implementations';
import { IdInputDto, UpdateAccountDto } from '@scani/shared';
import { z } from 'zod';
import { emitEntityChange } from '../../infrastructure/websocket/RealTimeUpdatesService';
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

  getByWalletId: protectedProcedure
    .input(
      z.object({
        walletId: z.string().uuid(),
        includeRemoved: z.boolean().optional().default(false),
      })
    )
    .query(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      return await AccountImplementations.getByWalletId(
        { userId: dbUser.id, dbUser },
        { walletId: input.walletId, includeRemoved: input.includeRemoved }
      );
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

  restore: protectedProcedure.input(IdInputDto).mutation(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);

    const result = await AccountImplementations.restore(
      { userId: dbUser.id, dbUser },
      { id: input.id }
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

  bulkDelete: protectedProcedure
    .input(z.object({ ids: z.array(z.string()).min(1) }))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const result = await AccountImplementations.bulkDelete(
        { userId: dbUser.id, dbUser },
        { ids: input.ids }
      );

      // Emit entity change events only for successfully deleted accounts
      for (const id of result.deletedIds) {
        emitEntityChange({
          type: 'entity_changed',
          entityType: 'account',
          operationType: 'delete',
          entityId: id,
          userId: dbUser.id,
          data: {},
        });
      }

      return result;
    }),

  bulkAssignGroups: protectedProcedure
    .input(
      z.object({
        accountIds: z.array(z.string()).min(1),
        groupIds: z.array(z.string()),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const result = await AccountImplementations.bulkAssignGroups(
        { userId: dbUser.id, dbUser },
        { accountIds: input.accountIds, groupIds: input.groupIds }
      );

      // Emit entity change events for updated accounts
      for (const id of input.accountIds) {
        emitEntityChange({
          type: 'entity_changed',
          entityType: 'account',
          operationType: 'update',
          entityId: id,
          userId: dbUser.id,
          data: {},
        });
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
