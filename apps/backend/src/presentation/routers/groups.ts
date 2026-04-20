import { GroupImplementations } from '@scani/domain/features';
import { emitBulkEntityChanges, emitEntityChange } from '@scani/realtime';
import {
  AssignAccountGroupsDto,
  AssignHoldingGroupsDto,
  CreateGroupDto,
  IdInputDto,
  UpdateGroupDto,
} from '@scani/shared';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

export const groupsRouter = router({
  // Get all groups for the user
  getAll: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await GroupImplementations.getAll({ userId: dbUser.id, dbUser }, {});
  }),

  // Get all groups with counts (holdings and accounts)
  getAllWithCounts: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await GroupImplementations.getAllWithCounts({ userId: dbUser.id, dbUser }, {});
  }),

  // Get a specific group by ID
  getById: protectedProcedure.input(IdInputDto).query(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await GroupImplementations.getById({ userId: dbUser.id, dbUser }, { id: input.id });
  }),

  // Create a new group
  create: protectedProcedure.input(CreateGroupDto).mutation(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);

    const result = await GroupImplementations.create({ userId: dbUser.id, dbUser }, input);

    emitEntityChange({
      type: 'entity_changed',
      entityType: 'group',
      operationType: 'create',
      entityId: result.id,
      userId: dbUser.id,
      data: result as Record<string, unknown>,
    });

    return result;
  }),

  // Update an existing group
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        data: UpdateGroupDto,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const result = await GroupImplementations.update(
        { userId: dbUser.id, dbUser },
        { id: input.id, data: input.data }
      );

      emitEntityChange({
        type: 'entity_changed',
        entityType: 'group',
        operationType: 'update',
        entityId: input.id,
        userId: dbUser.id,
        data: result as Record<string, unknown>,
      });

      return result;
    }),

  // Delete a group
  delete: protectedProcedure.input(IdInputDto).mutation(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);

    const result = await GroupImplementations.delete(
      { userId: dbUser.id, dbUser },
      { id: input.id }
    );

    emitEntityChange({
      type: 'entity_changed',
      entityType: 'group',
      operationType: 'delete',
      entityId: input.id,
      userId: dbUser.id,
      data: {},
    });

    return result;
  }),

  // Bulk delete groups
  bulkDelete: protectedProcedure
    .input(z.object({ ids: z.array(z.string()).min(1) }))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const result = await GroupImplementations.bulkDelete(
        { userId: dbUser.id, dbUser },
        { ids: input.ids }
      );

      // PERFORMANCE: Emit single bulk event instead of looping
      if (result.deletedIds.length > 0) {
        emitBulkEntityChanges('group', 'delete', result.deletedIds, dbUser.id);
      }

      return result;
    }),

  // Assign groups to a holding
  assignHoldingGroups: protectedProcedure
    .input(AssignHoldingGroupsDto)
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const result = await GroupImplementations.assignHoldingGroups(
        { userId: dbUser.id, dbUser },
        input
      );

      emitEntityChange({
        type: 'entity_changed',
        entityType: 'holding',
        operationType: 'update',
        entityId: input.holdingId,
        userId: dbUser.id,
        metadata: {
          groupsUpdated: true,
        },
      });

      return result;
    }),

  // Assign groups to an account
  assignAccountGroups: protectedProcedure
    .input(AssignAccountGroupsDto)
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const result = await GroupImplementations.assignAccountGroups(
        { userId: dbUser.id, dbUser },
        input
      );

      emitEntityChange({
        type: 'entity_changed',
        entityType: 'account',
        operationType: 'update',
        entityId: input.accountId,
        userId: dbUser.id,
        metadata: {
          groupsUpdated: true,
        },
      });

      return result;
    }),

  // Get groups assigned to a holding
  getHoldingGroups: protectedProcedure.input(IdInputDto).query(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await GroupImplementations.getHoldingGroups(
      { userId: dbUser.id, dbUser },
      { holdingId: input.id }
    );
  }),

  // Get groups assigned to an account
  getAccountGroups: protectedProcedure.input(IdInputDto).query(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await GroupImplementations.getAccountGroups(
      { userId: dbUser.id, dbUser },
      { accountId: input.id }
    );
  }),
});
