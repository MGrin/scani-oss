import { AccountImplementations } from '@scani/core/features/implementations';
import { IdInputDto } from '@scani/shared';
import { z } from 'zod';
import { emitEntityChange } from '../../infrastructure/websocket/RealTimeUpdatesService';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

export const accountsRouter = router({
  getAll: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = requireAuth(ctx);
    return await AccountImplementations.getAll({ userId: dbUser.id, dbUser }, {});
  }),

  getByUserIdWithSummary: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = requireAuth(ctx);
    return await AccountImplementations.getByUserIdWithSummary({ userId: dbUser.id, dbUser }, {});
  }),

  getById: protectedProcedure.input(IdInputDto).query(async ({ input, ctx }) => {
    const { dbUser } = requireAuth(ctx);
    return await AccountImplementations.getById({ userId: dbUser.id, dbUser }, { id: input.id });
  }),

  getHoldings: protectedProcedure.input(IdInputDto).query(async ({ input, ctx }) => {
    const { dbUser } = requireAuth(ctx);
    return await AccountImplementations.getHoldings(
      { userId: dbUser.id, dbUser },
      { id: input.id }
    );
  }),

  delete: protectedProcedure.input(IdInputDto).mutation(async ({ input, ctx }) => {
    const { dbUser } = requireAuth(ctx);

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
      const { dbUser } = requireAuth(ctx);

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
});
