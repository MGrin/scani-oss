import { HoldingImplementations } from '@scani/core/features/implementations';
import { UpdateHoldingDto } from '@scani/shared';
import { z } from 'zod';
import { emitEntityChange } from '../../infrastructure/websocket/RealTimeUpdatesService';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

export const holdingsRouter = router({
  // Get all holdings with full details (for Holdings page)
  getWithDetails: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = requireAuth(ctx);
    return await HoldingImplementations.getWithDetails({ userId: dbUser.id, dbUser }, {});
  }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        data: UpdateHoldingDto,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = requireAuth(ctx);

      const updatedHolding = await HoldingImplementations.update(
        { userId: dbUser.id, dbUser },
        { id: input.id, data: input.data }
      );

      emitEntityChange({
        type: 'entity_changed',
        entityType: 'holding',
        operationType: 'update',
        entityId: updatedHolding.id,
        userId: dbUser.id,
        data: {
          accountId: updatedHolding.accountId,
          tokenId: updatedHolding.tokenId,
        },
      });

      return updatedHolding;
    }),

  // Delete holding (with cascading to transactions)
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = requireAuth(ctx);

      const result = await HoldingImplementations.delete(
        { userId: dbUser.id, dbUser },
        { id: input.id }
      );

      emitEntityChange({
        type: 'entity_changed',
        entityType: 'holding',
        operationType: 'delete',
        entityId: result.deleted.id,
        userId: dbUser.id,
        metadata: {
          relatedEntities: [
            {
              type: 'account',
              id: result.deleted.accountId,
            },
          ],
        },
      });

      return result;
    }),

  bulkDelete: protectedProcedure
    .input(z.object({ ids: z.array(z.string()).min(1) }))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = requireAuth(ctx);

      const result = await HoldingImplementations.bulkDelete(
        { userId: dbUser.id, dbUser },
        { ids: input.ids }
      );

      // Emit entity change events only for successfully deleted holdings
      for (const id of result.deletedIds) {
        emitEntityChange({
          type: 'entity_changed',
          entityType: 'holding',
          operationType: 'delete',
          entityId: id,
          userId: dbUser.id,
        });
      }

      return result;
    }),

  // Update holding price by forcing fresh fetch from pricing providers
  updatePrice: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = requireAuth(ctx);

      const result = await HoldingImplementations.updatePrice(
        { userId: dbUser.id, dbUser },
        { id: input.id }
      );

      // Emit entity change event to trigger real-time updates
      emitEntityChange({
        type: 'entity_changed',
        entityType: 'holding',
        operationType: 'update',
        entityId: input.id,
        userId: dbUser.id,
      });

      return result;
    }),

  bulkAssignGroups: protectedProcedure
    .input(
      z.object({
        holdingIds: z.array(z.string()).min(1),
        groupIds: z.array(z.string()),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = requireAuth(ctx);

      const result = await HoldingImplementations.bulkAssignGroups(
        { userId: dbUser.id, dbUser },
        { holdingIds: input.holdingIds, groupIds: input.groupIds }
      );

      // Emit entity change events for updated holdings
      for (const id of input.holdingIds) {
        emitEntityChange({
          type: 'entity_changed',
          entityType: 'holding',
          operationType: 'update',
          entityId: id,
          userId: dbUser.id,
          data: {},
        });
      }

      return result;
    }),

  getCommonGroups: protectedProcedure
    .input(z.object({ holdingIds: z.array(z.string()).min(1) }))
    .query(async ({ input, ctx }) => {
      const { dbUser } = requireAuth(ctx);

      const result = await HoldingImplementations.getCommonGroups(
        { userId: dbUser.id, dbUser },
        { holdingIds: input.holdingIds }
      );

      return result;
    }),
});
