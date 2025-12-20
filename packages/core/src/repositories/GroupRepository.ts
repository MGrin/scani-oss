import { and, eq, inArray } from 'drizzle-orm';
import { Service } from 'typedi';
import * as schema from '../database/schema';
import type { Group, NewGroup } from '../domain/entities';
import { BaseRepository, type DatabaseTransaction } from './BaseRepository';

@Service()
export class GroupRepository extends BaseRepository<Group, NewGroup> {
  protected readonly table = schema.groups;
  protected readonly tableName = 'groups';

  async findByUser(userId: string, transaction?: DatabaseTransaction): Promise<Group[]> {
    try {
      const database = this.getDb(transaction);
      return await database
        .select()
        .from(schema.groups)
        .where(and(eq(schema.groups.userId, userId), eq(schema.groups.isActive, true)))
        .orderBy(schema.groups.displayOrder, schema.groups.name);
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to find groups by user');
      throw error;
    }
  }

  async findByUserWithCounts(
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<
    Array<
      Group & {
        holdingsCount: number;
        accountsCount: number;
      }
    >
  > {
    try {
      const database = this.getDb(transaction);

      // Get all groups for the user
      const groups = await this.findByUser(userId, transaction);

      // Get counts for each group
      const results = await Promise.all(
        groups.map(async (group) => {
          // Count holdings
          const holdingsCount = await database
            .select()
            .from(schema.holdingGroups)
            .where(eq(schema.holdingGroups.groupId, group.id))
            .then((rows) => rows.length);

          // Count accounts
          const accountsCount = await database
            .select()
            .from(schema.accountGroups)
            .where(eq(schema.accountGroups.groupId, group.id))
            .then((rows) => rows.length);

          return {
            ...group,
            holdingsCount,
            accountsCount,
          };
        })
      );

      return results;
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to find groups with counts');
      throw error;
    }
  }

  async findGroupsByHoldingId(
    holdingId: string,
    transaction?: DatabaseTransaction
  ): Promise<Group[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({
          group: schema.groups,
        })
        .from(schema.holdingGroups)
        .innerJoin(schema.groups, eq(schema.holdingGroups.groupId, schema.groups.id))
        .where(eq(schema.holdingGroups.holdingId, holdingId));

      return results.map((r) => r.group);
    } catch (error) {
      this.logger.error({ holdingId, error }, 'Failed to find groups by holding');
      throw error;
    }
  }

  async findGroupsByAccountId(
    accountId: string,
    transaction?: DatabaseTransaction
  ): Promise<Group[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({
          group: schema.groups,
        })
        .from(schema.accountGroups)
        .innerJoin(schema.groups, eq(schema.accountGroups.groupId, schema.groups.id))
        .where(eq(schema.accountGroups.accountId, accountId));

      return results.map((r) => r.group);
    } catch (error) {
      this.logger.error({ accountId, error }, 'Failed to find groups by account');
      throw error;
    }
  }

  // Holding Groups methods
  async assignHoldingGroups(
    holdingId: string,
    groupIds: string[],
    transaction?: DatabaseTransaction
  ): Promise<void> {
    try {
      const database = this.getDb(transaction);

      // Remove existing assignments
      await database
        .delete(schema.holdingGroups)
        .where(eq(schema.holdingGroups.holdingId, holdingId));

      // Add new assignments
      if (groupIds.length > 0) {
        await database.insert(schema.holdingGroups).values(
          groupIds.map((groupId) => ({
            holdingId,
            groupId,
          }))
        );
      }
    } catch (error) {
      this.logger.error({ holdingId, groupIds, error }, 'Failed to assign holding groups');
      throw error;
    }
  }

  // Account Groups methods
  async assignAccountGroups(
    accountId: string,
    groupIds: string[],
    transaction?: DatabaseTransaction
  ): Promise<void> {
    try {
      const database = this.getDb(transaction);

      // Remove existing assignments
      await database
        .delete(schema.accountGroups)
        .where(eq(schema.accountGroups.accountId, accountId));

      // Add new assignments
      if (groupIds.length > 0) {
        await database.insert(schema.accountGroups).values(
          groupIds.map((groupId) => ({
            accountId,
            groupId,
          }))
        );
      }
    } catch (error) {
      this.logger.error({ accountId, groupIds, error }, 'Failed to assign account groups');
      throw error;
    }
  }

  async getHoldingsByGroupId(
    groupId: string,
    transaction?: DatabaseTransaction
  ): Promise<string[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({ holdingId: schema.holdingGroups.holdingId })
        .from(schema.holdingGroups)
        .where(eq(schema.holdingGroups.groupId, groupId));

      return results.map((r) => r.holdingId);
    } catch (error) {
      this.logger.error({ groupId, error }, 'Failed to get holdings by group');
      throw error;
    }
  }

  async getAccountsByGroupId(
    groupId: string,
    transaction?: DatabaseTransaction
  ): Promise<string[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({ accountId: schema.accountGroups.accountId })
        .from(schema.accountGroups)
        .where(eq(schema.accountGroups.groupId, groupId));

      return results.map((r) => r.accountId);
    } catch (error) {
      this.logger.error({ groupId, error }, 'Failed to get accounts by group');
      throw error;
    }
  }

  /**
   * Get groups for multiple holdings and their accounts in a single query
   * Returns a map of holdingId -> groups array
   */
  async findGroupsForHoldings(
    holdings: Array<{ id: string; accountId: string }>,
    transaction?: DatabaseTransaction
  ): Promise<Map<string, Group[]>> {
    try {
      const database = this.getDb(transaction);

      if (holdings.length === 0) {
        return new Map();
      }

      const holdingIds = holdings.map((h) => h.id);
      const accountIds = [...new Set(holdings.map((h) => h.accountId))];

      // Get direct holding groups
      const holdingGroupsResults = await database
        .select({
          holdingId: schema.holdingGroups.holdingId,
          group: schema.groups,
        })
        .from(schema.holdingGroups)
        .innerJoin(schema.groups, eq(schema.holdingGroups.groupId, schema.groups.id))
        .where(inArray(schema.holdingGroups.holdingId, holdingIds));

      // Get account groups
      const accountGroupsResults = await database
        .select({
          accountId: schema.accountGroups.accountId,
          group: schema.groups,
        })
        .from(schema.accountGroups)
        .innerJoin(schema.groups, eq(schema.accountGroups.groupId, schema.groups.id))
        .where(inArray(schema.accountGroups.accountId, accountIds));

      // Build map of holdingId -> groups
      const groupsMap = new Map<string, Group[]>();

      // Add direct holding groups
      for (const result of holdingGroupsResults) {
        const existing = groupsMap.get(result.holdingId) || [];
        groupsMap.set(result.holdingId, [...existing, result.group]);
      }

      // Add account-level groups to holdings
      for (const holding of holdings) {
        const accountGroups = accountGroupsResults.filter((r) => r.accountId === holding.accountId);
        const existing = groupsMap.get(holding.id) || [];
        const accountGroupList = accountGroups.map((r) => r.group);

        // Combine and deduplicate by group id
        const combined = [...existing, ...accountGroupList];
        const unique = Array.from(new Map(combined.map((g) => [g.id, g])).values());

        groupsMap.set(holding.id, unique);
      }

      return groupsMap;
    } catch (error) {
      this.logger.error({ error }, 'Failed to find groups for holdings');
      throw error;
    }
  }
}
