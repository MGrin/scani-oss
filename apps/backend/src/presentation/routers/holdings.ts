import { HoldingImplementations } from '@scani/core/features/implementations';
import { JOB_NAMES } from '@scani/core/queues';
import { UpdateHoldingDto, UpsertHoldingApyConfigDto } from '@scani/shared';
import { z } from 'zod';
import {
  emitBulkEntityChanges,
  emitEntityChange,
} from '../../infrastructure/websocket/RealTimeUpdatesService';
import { enqueueJob } from '../../queues/enqueue';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

export const holdingsRouter = router({
  // Get all holdings with full details (for Holdings page)
  getWithDetails: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await HoldingImplementations.getWithDetails({ userId: dbUser.id, dbUser }, {});
  }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        data: UpdateHoldingDto,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

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
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

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
      const { dbUser } = await requireAuth(ctx);

      const result = await HoldingImplementations.bulkDelete(
        { userId: dbUser.id, dbUser },
        { ids: input.ids }
      );

      // PERFORMANCE: Emit single bulk event instead of looping
      if (result.deletedIds.length > 0) {
        emitBulkEntityChanges('holding', 'delete', result.deletedIds, dbUser.id);
      }

      return result;
    }),

  // Restore a hidden holding (unmark as hidden)
  restore: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const result = await HoldingImplementations.restore(
        { userId: dbUser.id, dbUser },
        { id: input.id }
      );

      emitEntityChange({
        type: 'entity_changed',
        entityType: 'holding',
        operationType: 'update',
        entityId: result.id,
        userId: dbUser.id,
        data: {
          accountId: result.accountId,
          tokenId: result.tokenId,
        },
      });

      return result;
    }),

  /**
   * Enqueue a holding price refresh. Fetches fresh price from pricing
   * providers (1–3s), then cascades to vault recalculation on the worker.
   * Returns a jobId for the UI to track.
   */
  updatePrice: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        requestId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      const jobId = await enqueueJob(JOB_NAMES.holdingPriceUpdate, {
        userId: dbUser.id,
        requestId: input.requestId,
        holdingId: input.id,
        // The worker fetches fresh price from providers; these fields are
        // placeholders for a future manual-override payload.
        priceUsd: 0,
        priceSource: 'fetch',
      });
      return { jobId };
    }),

  bulkAssignGroups: protectedProcedure
    .input(
      z.object({
        holdingIds: z.array(z.string()).min(1),
        // The dialog computes an explicit diff between the pre-checked
        // common-groups state and the user's save selection, then sends
        // add/remove sets. Preferable to REPLACE semantics because
        // REPLACE would clobber any per-holding groups that weren't in
        // the pre-checked set.
        addedGroupIds: z.array(z.string()).default([]),
        removedGroupIds: z.array(z.string()).default([]),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const result = await HoldingImplementations.bulkAssignGroups(
        { userId: dbUser.id, dbUser },
        {
          holdingIds: input.holdingIds,
          addedGroupIds: input.addedGroupIds,
          removedGroupIds: input.removedGroupIds,
        }
      );

      // PERFORMANCE: Emit single bulk event instead of looping
      if (input.holdingIds.length > 0) {
        emitBulkEntityChanges('holding', 'update', input.holdingIds, dbUser.id);
      }

      return result;
    }),

  getCommonGroups: protectedProcedure
    // Allow empty arrays — "common groups across 0 holdings" is well-
    // defined (empty set), and the frontend can transiently pass []
    // while the dialog is mounting or mid-transition. Returning []
    // is cheaper and friendlier than a 400.
    .input(z.object({ holdingIds: z.array(z.string()) }))
    .query(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      if (input.holdingIds.length === 0) return [];

      const result = await HoldingImplementations.getCommonGroups(
        { userId: dbUser.id, dbUser },
        { holdingIds: input.holdingIds }
      );

      return result;
    }),

  // APY Config endpoints
  getApyConfig: protectedProcedure
    .input(z.object({ holdingId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      return await HoldingImplementations.getApyConfig(
        { userId: dbUser.id, dbUser },
        { holdingId: input.holdingId }
      );
    }),

  upsertApyConfig: protectedProcedure
    .input(UpsertHoldingApyConfigDto)
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const result = await HoldingImplementations.upsertApyConfig(
        { userId: dbUser.id, dbUser },
        {
          holdingId: input.holdingId,
          annualRatePct: input.annualRatePct,
          payoutFrequency: input.payoutFrequency,
          payoutDayOfWeek: input.payoutDayOfWeek,
          payoutDayOfMonth: input.payoutDayOfMonth,
          payoutMonth: input.payoutMonth,
        }
      );

      emitEntityChange({
        type: 'entity_changed',
        entityType: 'holding',
        operationType: 'update',
        entityId: input.holdingId,
        userId: dbUser.id,
      });

      return result;
    }),

  deleteApyConfig: protectedProcedure
    .input(z.object({ holdingId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const result = await HoldingImplementations.deleteApyConfig(
        { userId: dbUser.id, dbUser },
        { holdingId: input.holdingId }
      );

      emitEntityChange({
        type: 'entity_changed',
        entityType: 'holding',
        operationType: 'update',
        entityId: input.holdingId,
        userId: dbUser.id,
      });

      return result;
    }),
});
