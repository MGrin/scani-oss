import type { Group } from '@scani/db/schema';
import { AccountRepository, GroupRepository, HoldingRepository } from '@scani/domain/repositories';
import { AssignAccountGroupsUseCase, AssignHoldingGroupsUseCase } from '@scani/domain/use-cases';
import { emitBulkEntityChanges, emitEntityChange } from '@scani/realtime';
import {
  AssignAccountGroupsDto,
  AssignHoldingGroupsDto,
  CreateGroupDto,
  IdInputDto,
  UpdateGroupDto,
} from '@scani/shared';
import { Container } from 'typedi';
import { z } from 'zod';
import { executeBulkOperation } from '../lib/bulk-operation';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

async function deleteGroup(id: string, userId: string): Promise<{ success: true }> {
  const groupRepository = Container.get(GroupRepository);
  const group = await groupRepository.findById(id);
  if (!group || group.userId !== userId) {
    throw new Error('Unauthorized access to group');
  }
  await groupRepository.delete(id);
  return { success: true };
}

export const groupsRouter = router({
  // Get all groups for the user
  getAll: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await Container.get(GroupRepository).findByUser(dbUser.id);
  }),

  // Get all groups with counts (holdings and accounts)
  getAllWithCounts: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await Container.get(GroupRepository).findByUserWithCounts(dbUser.id);
  }),

  // Get a specific group by ID
  getById: protectedProcedure.input(IdInputDto).query(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    const group = await Container.get(GroupRepository).findById(input.id);
    if (group && group.userId !== dbUser.id) {
      throw new Error('Unauthorized access to group');
    }
    return group;
  }),

  // Create a new group
  create: protectedProcedure.input(CreateGroupDto).mutation(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    const groupRepository = Container.get(GroupRepository);

    let result: Group;
    try {
      result = await groupRepository.create({
        userId: dbUser.id,
        name: input.name,
        color: input.color,
        description: input.description || null,
        displayOrder: input.displayOrder || 0,
        isActive: true,
      });
    } catch (error) {
      // PostgreSQL error 23505 = unique_violation on (userId, name).
      if (
        error instanceof Error &&
        ((error as unknown as { code: string }).code === '23505' ||
          error.message.includes('unique constraint') ||
          error.message.includes('duplicate key') ||
          error.message.includes('uniqueUserGroupName'))
      ) {
        throw new Error(`A group with the name "${input.name}" already exists`);
      }
      throw error;
    }

    emitEntityChange({
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
      const groupRepository = Container.get(GroupRepository);
      const group = await groupRepository.findById(input.id);
      if (!group || group.userId !== dbUser.id) {
        throw new Error('Unauthorized access to group');
      }
      const result = await groupRepository.update(input.id, input.data);

      emitEntityChange({
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

    const result = await deleteGroup(input.id, dbUser.id);

    emitEntityChange({
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

      const result = await executeBulkOperation(input.ids, (id) => deleteGroup(id, dbUser.id));

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

      const result = await Container.get(AssignHoldingGroupsUseCase).execute(input, dbUser.id);

      emitEntityChange({
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

      const result = await Container.get(AssignAccountGroupsUseCase).execute(input, dbUser.id);

      emitEntityChange({
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
    const groupRepository = Container.get(GroupRepository);
    const holdingRepository = Container.get(HoldingRepository);
    const holding = await holdingRepository.findByIdVisible(input.id);
    if (!holding || holding.userId !== dbUser.id) {
      throw new Error('Unauthorized access to holding');
    }
    return await groupRepository.findGroupsByHoldingId(input.id);
  }),

  // Get groups assigned to an account
  getAccountGroups: protectedProcedure.input(IdInputDto).query(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    const groupRepository = Container.get(GroupRepository);
    const accountRepository = Container.get(AccountRepository);
    const account = await accountRepository.findById(input.id);
    if (!account || account.userId !== dbUser.id) {
      throw new Error('Unauthorized access to account');
    }
    return await groupRepository.findGroupsByAccountId(input.id);
  }),
});
