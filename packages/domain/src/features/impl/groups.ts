import { Container } from 'typedi';
import { AccountRepository, GroupRepository, HoldingRepository } from '../../repositories';
import { executeBulkOperation, type FeatureExecutionContext } from '../context';

/**
 * Groups feature implementations. Extracted from `features/index.ts`
 * (was 230+ LOC). Covers group CRUD, holding/account group
 * assignment, and the bulk-diff helpers the AssignGroups dialog uses.
 *
 * A few invariants worth knowing before editing:
 *   - Group ownership is `userId`-scoped. Every ID lookup verifies
 *     `group.userId === context.userId` before returning / mutating.
 *   - Account-group membership is **derived** from holding-group
 *     membership: an account is "in" G iff every visible holding of
 *     the account is in G. The `accountGroups` table is a cache of
 *     that derivation — `recomputeAccountGroups` rebuilds it whenever
 *     `holdingGroups` changes.
 */
export const GroupImplementations = {
  async getAll(context: FeatureExecutionContext, _input: Record<string, never>) {
    const groupRepository = Container.get(GroupRepository);
    return await groupRepository.findByUser(context.userId);
  },

  async getAllWithCounts(context: FeatureExecutionContext, _input: Record<string, never>) {
    const groupRepository = Container.get(GroupRepository);
    return await groupRepository.findByUserWithCounts(context.userId);
  },

  async getById(context: FeatureExecutionContext, input: { id: string }) {
    const groupRepository = Container.get(GroupRepository);
    const group = await groupRepository.findById(input.id);
    if (group && group.userId !== context.userId) {
      throw new Error('Unauthorized access to group');
    }
    return group;
  },

  async create(
    context: FeatureExecutionContext,
    input: { name: string; color: string; description?: string | null; displayOrder?: number }
  ) {
    const groupRepository = Container.get(GroupRepository);
    try {
      return await groupRepository.create({
        userId: context.userId,
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
  },

  async update(
    context: FeatureExecutionContext,
    input: {
      id: string;
      data: {
        name?: string;
        color?: string;
        description?: string | null;
        displayOrder?: number;
        isActive?: boolean;
      };
    }
  ) {
    const groupRepository = Container.get(GroupRepository);
    const group = await groupRepository.findById(input.id);
    if (!group || group.userId !== context.userId) {
      throw new Error('Unauthorized access to group');
    }
    return await groupRepository.update(input.id, input.data);
  },

  async delete(context: FeatureExecutionContext, input: { id: string }) {
    const groupRepository = Container.get(GroupRepository);
    const group = await groupRepository.findById(input.id);
    if (!group || group.userId !== context.userId) {
      throw new Error('Unauthorized access to group');
    }
    await groupRepository.delete(input.id);
    return { success: true };
  },

  async bulkDelete(context: FeatureExecutionContext, input: { ids: string[] }) {
    return executeBulkOperation(input.ids, async (id) => {
      await GroupImplementations.delete(context, { id });
    });
  },

  async assignHoldingGroups(
    context: FeatureExecutionContext,
    input: { holdingId: string; groupIds: string[] }
  ) {
    const groupRepository = Container.get(GroupRepository);
    const holdingRepository = Container.get(HoldingRepository);

    const holding = await holdingRepository.findByIdVisible(input.holdingId);
    if (!holding || holding.userId !== context.userId) {
      throw new Error('Unauthorized access to holding');
    }

    if (input.groupIds.length > 0) {
      const groups = await Promise.all(input.groupIds.map((id) => groupRepository.findById(id)));
      if (groups.some((g) => !g || g.userId !== context.userId)) {
        throw new Error('Unauthorized access to one or more groups');
      }
    }

    // REPLACE semantics for this legacy single-holding endpoint: diff
    // against current state so the underlying ops still go through the
    // diff-based repo methods (which recompute `accountGroups` for the
    // parent account).
    const currentGroups = await groupRepository.findGroupsByHoldingId(input.holdingId);
    const currentIds = new Set(currentGroups.map((g) => g.id));
    const desired = new Set(input.groupIds);
    const toAdd = input.groupIds.filter((id) => !currentIds.has(id));
    const toRemove = Array.from(currentIds).filter((id) => !desired.has(id));

    if (toAdd.length > 0) await groupRepository.bulkAddHoldingGroups([input.holdingId], toAdd);
    if (toRemove.length > 0) {
      await groupRepository.bulkRemoveHoldingGroups([input.holdingId], toRemove);
    }
    if (toAdd.length > 0 || toRemove.length > 0) {
      const parentIds = await groupRepository.findParentAccountIdsForHoldings([input.holdingId]);
      if (parentIds.length > 0) await groupRepository.recomputeAccountGroups(parentIds);
    }
    return { success: true };
  },

  async assignAccountGroups(
    context: FeatureExecutionContext,
    input: { accountId: string; groupIds: string[] }
  ) {
    const groupRepository = Container.get(GroupRepository);
    const accountRepository = Container.get(AccountRepository);

    const account = await accountRepository.findById(input.accountId);
    if (!account || account.userId !== context.userId) {
      throw new Error('Unauthorized access to account');
    }

    if (input.groupIds.length > 0) {
      const groups = await Promise.all(input.groupIds.map((id) => groupRepository.findById(id)));
      if (groups.some((g) => !g || g.userId !== context.userId)) {
        throw new Error('Unauthorized access to one or more groups');
      }
    }

    // Legacy single-account endpoint — route through the bulk path so
    // it picks up the cascade-to-holdings semantics.
    const currentGroups = await groupRepository.findGroupsByAccountId(input.accountId);
    const currentIds = new Set(currentGroups.map((g) => g.id));
    const desired = new Set(input.groupIds);
    const addedGroupIds = input.groupIds.filter((id) => !currentIds.has(id));
    const removedGroupIds = Array.from(currentIds).filter((id) => !desired.has(id));

    const holdingIds = await groupRepository.findVisibleHoldingIdsForAccounts([input.accountId]);
    if (holdingIds.length > 0) {
      if (addedGroupIds.length > 0) {
        await groupRepository.bulkAddHoldingGroups(holdingIds, addedGroupIds);
      }
      if (removedGroupIds.length > 0) {
        await groupRepository.bulkRemoveHoldingGroups(holdingIds, removedGroupIds);
      }
    }
    await groupRepository.recomputeAccountGroups([input.accountId]);
    return { success: true };
  },

  async getHoldingGroups(context: FeatureExecutionContext, input: { holdingId: string }) {
    const groupRepository = Container.get(GroupRepository);
    const holdingRepository = Container.get(HoldingRepository);
    const holding = await holdingRepository.findByIdVisible(input.holdingId);
    if (!holding || holding.userId !== context.userId) {
      throw new Error('Unauthorized access to holding');
    }
    return await groupRepository.findGroupsByHoldingId(input.holdingId);
  },

  async getAccountGroups(context: FeatureExecutionContext, input: { accountId: string }) {
    const groupRepository = Container.get(GroupRepository);
    const accountRepository = Container.get(AccountRepository);
    const account = await accountRepository.findById(input.accountId);
    if (!account || account.userId !== context.userId) {
      throw new Error('Unauthorized access to account');
    }
    return await groupRepository.findGroupsByAccountId(input.accountId);
  },
};
