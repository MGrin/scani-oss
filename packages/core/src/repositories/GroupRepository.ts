import { and, eq, inArray, sql } from "drizzle-orm";
import { Service } from "typedi";
import * as schema from "../database/schema";
import type { Group, NewGroup } from "../domain/entities";
import { BaseRepository, type DatabaseTransaction } from "./BaseRepository";

@Service()
export class GroupRepository extends BaseRepository<Group, NewGroup> {
  protected readonly table = schema.groups;
  protected readonly tableName = "groups";

  async findByUser(
    userId: string,
    transaction?: DatabaseTransaction,
  ): Promise<Group[]> {
    try {
      const database = this.getDb(transaction);
      return await database
        .select()
        .from(schema.groups)
        .where(
          and(
            eq(schema.groups.userId, userId),
            eq(schema.groups.isActive, true),
          ),
        )
        .orderBy(schema.groups.displayOrder, schema.groups.name);
    } catch (error) {
      this.logger.error({ userId, error }, "Failed to find groups by user");
      throw error;
    }
  }

  async findByUserWithCounts(
    userId: string,
    transaction?: DatabaseTransaction,
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

      // Optimized query using subqueries for counts - single DB query instead of N+1
      const results = await database
        .select({
          id: schema.groups.id,
          userId: schema.groups.userId,
          name: schema.groups.name,
          color: schema.groups.color,
          description: schema.groups.description,
          displayOrder: schema.groups.displayOrder,
          isActive: schema.groups.isActive,
          createdAt: schema.groups.createdAt,
          updatedAt: schema.groups.updatedAt,
          holdingsCount: sql<number>`COALESCE(COUNT(DISTINCT ${schema.holdingGroups.holdingId}), 0)`,
          accountsCount: sql<number>`COALESCE(COUNT(DISTINCT ${schema.accountGroups.accountId}), 0)`,
        })
        .from(schema.groups)
        .leftJoin(
          schema.holdingGroups,
          eq(schema.groups.id, schema.holdingGroups.groupId),
        )
        .leftJoin(
          schema.accountGroups,
          eq(schema.groups.id, schema.accountGroups.groupId),
        )
        .where(
          and(
            eq(schema.groups.userId, userId),
            eq(schema.groups.isActive, true),
          ),
        )
        .groupBy(
          schema.groups.id,
          schema.groups.userId,
          schema.groups.name,
          schema.groups.color,
          schema.groups.description,
          schema.groups.displayOrder,
          schema.groups.isActive,
          schema.groups.createdAt,
          schema.groups.updatedAt,
        )
        .orderBy(schema.groups.displayOrder, schema.groups.name);

      return results as Array<
        Group & {
          holdingsCount: number;
          accountsCount: number;
        }
      >;
    } catch (error) {
      this.logger.error({ userId, error }, "Failed to find groups with counts");
      throw error;
    }
  }

  async findGroupsByHoldingId(
    holdingId: string,
    transaction?: DatabaseTransaction,
  ): Promise<Group[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({
          group: schema.groups,
        })
        .from(schema.holdingGroups)
        .innerJoin(
          schema.groups,
          eq(schema.holdingGroups.groupId, schema.groups.id),
        )
        .where(eq(schema.holdingGroups.holdingId, holdingId));

      return results.map((r) => r.group);
    } catch (error) {
      this.logger.error(
        { holdingId, error },
        "Failed to find groups by holding",
      );
      throw error;
    }
  }

  async findGroupsByAccountId(
    accountId: string,
    transaction?: DatabaseTransaction,
  ): Promise<Group[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({
          group: schema.groups,
        })
        .from(schema.accountGroups)
        .innerJoin(
          schema.groups,
          eq(schema.accountGroups.groupId, schema.groups.id),
        )
        .where(eq(schema.accountGroups.accountId, accountId));

      return results.map((r) => r.group);
    } catch (error) {
      this.logger.error(
        { accountId, error },
        "Failed to find groups by account",
      );
      throw error;
    }
  }

  // Holding Groups methods
  async assignHoldingGroups(
    holdingId: string,
    groupIds: string[],
    transaction?: DatabaseTransaction,
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
          })),
        );
      }
    } catch (error) {
      this.logger.error(
        { holdingId, groupIds, error },
        "Failed to assign holding groups",
      );
      throw error;
    }
  }

  // Account Groups methods
  async assignAccountGroups(
    accountId: string,
    groupIds: string[],
    transaction?: DatabaseTransaction,
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
          })),
        );
      }
    } catch (error) {
      this.logger.error(
        { accountId, groupIds, error },
        "Failed to assign account groups",
      );
      throw error;
    }
  }

  /**
   * PERFORMANCE: Bulk assign groups to multiple accounts in a single transaction
   * Much more efficient than calling assignAccountGroups in a loop
   */
  async bulkAssignAccountGroups(
    accountIds: string[],
    groupIds: string[],
    transaction?: DatabaseTransaction,
  ): Promise<{ successCount: number; failedCount: number }> {
    if (accountIds.length === 0) {
      return { successCount: 0, failedCount: 0 };
    }

    try {
      const database = this.getDb(transaction);

      // Remove existing assignments for all accounts in one query
      await database
        .delete(schema.accountGroups)
        .where(inArray(schema.accountGroups.accountId, accountIds));

      // Add new assignments for all accounts in one batch insert
      if (groupIds.length > 0) {
        const values = accountIds.flatMap((accountId) =>
          groupIds.map((groupId) => ({
            accountId,
            groupId,
          })),
        );

        await database.insert(schema.accountGroups).values(values);
      }

      this.logger.debug(
        { accountCount: accountIds.length, groupCount: groupIds.length },
        "Bulk assigned account groups",
      );

      return { successCount: accountIds.length, failedCount: 0 };
    } catch (error) {
      this.logger.error(
        { accountIds, groupIds, error },
        "Failed to bulk assign account groups",
      );
      throw error;
    }
  }

  /**
   * PERFORMANCE: Bulk assign groups to multiple holdings in a single transaction
   * Much more efficient than calling assignHoldingGroups in a loop
   */
  async bulkAssignHoldingGroups(
    holdingIds: string[],
    groupIds: string[],
    transaction?: DatabaseTransaction,
  ): Promise<{ successCount: number; failedCount: number }> {
    if (holdingIds.length === 0) {
      return { successCount: 0, failedCount: 0 };
    }

    try {
      const database = this.getDb(transaction);

      // Remove existing assignments for all holdings in one query
      await database
        .delete(schema.holdingGroups)
        .where(inArray(schema.holdingGroups.holdingId, holdingIds));

      // Add new assignments for all holdings in one batch insert
      if (groupIds.length > 0) {
        const values = holdingIds.flatMap((holdingId) =>
          groupIds.map((groupId) => ({
            holdingId,
            groupId,
          })),
        );

        await database.insert(schema.holdingGroups).values(values);
      }

      this.logger.debug(
        { holdingCount: holdingIds.length, groupCount: groupIds.length },
        "Bulk assigned holding groups",
      );

      return { successCount: holdingIds.length, failedCount: 0 };
    } catch (error) {
      this.logger.error(
        { holdingIds, groupIds, error },
        "Failed to bulk assign holding groups",
      );
      throw error;
    }
  }

  async getHoldingsByGroupId(
    groupId: string,
    transaction?: DatabaseTransaction,
  ): Promise<string[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({ holdingId: schema.holdingGroups.holdingId })
        .from(schema.holdingGroups)
        .where(eq(schema.holdingGroups.groupId, groupId));

      return results.map((r) => r.holdingId);
    } catch (error) {
      this.logger.error({ groupId, error }, "Failed to get holdings by group");
      throw error;
    }
  }

  async getAccountsByGroupId(
    groupId: string,
    transaction?: DatabaseTransaction,
  ): Promise<string[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select({ accountId: schema.accountGroups.accountId })
        .from(schema.accountGroups)
        .where(eq(schema.accountGroups.groupId, groupId));

      return results.map((r) => r.accountId);
    } catch (error) {
      this.logger.error({ groupId, error }, "Failed to get accounts by group");
      throw error;
    }
  }

  /**
   * Get groups for multiple holdings and their accounts in a single query
   * Returns a map of holdingId -> groups array
   */
  async findGroupsForHoldings(
    holdings: Array<{ id: string; accountId: string }>,
    transaction?: DatabaseTransaction,
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
        .innerJoin(
          schema.groups,
          eq(schema.holdingGroups.groupId, schema.groups.id),
        )
        .where(inArray(schema.holdingGroups.holdingId, holdingIds));

      // Get account groups
      const accountGroupsResults = await database
        .select({
          accountId: schema.accountGroups.accountId,
          group: schema.groups,
        })
        .from(schema.accountGroups)
        .innerJoin(
          schema.groups,
          eq(schema.accountGroups.groupId, schema.groups.id),
        )
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
        const accountGroups = accountGroupsResults.filter(
          (r) => r.accountId === holding.accountId,
        );
        const existing = groupsMap.get(holding.id) || [];
        const accountGroupList = accountGroups.map((r) => r.group);

        // Combine and deduplicate by group id
        const combined = [...existing, ...accountGroupList];
        const unique = Array.from(
          new Map(combined.map((g) => [g.id, g])).values(),
        );

        groupsMap.set(holding.id, unique);
      }

      return groupsMap;
    } catch (error) {
      this.logger.error({ error }, "Failed to find groups for holdings");
      throw error;
    }
  }

  /**
   * Find groups for multiple accounts
   * Returns a map of accountId -> groups array
   */
  async findGroupsForAccounts(
    accountIds: string[],
    transaction?: DatabaseTransaction,
  ): Promise<Map<string, Group[]>> {
    try {
      const database = this.getDb(transaction);

      if (accountIds.length === 0) {
        return new Map();
      }

      const groupsResults = await database
        .select({
          accountId: schema.accountGroups.accountId,
          group: schema.groups,
        })
        .from(schema.accountGroups)
        .innerJoin(
          schema.groups,
          eq(schema.accountGroups.groupId, schema.groups.id),
        )
        .where(inArray(schema.accountGroups.accountId, accountIds));

      // Build map of accountId -> groups
      const groupsMap = new Map<string, Group[]>();

      for (const result of groupsResults) {
        const existing = groupsMap.get(result.accountId) || [];
        groupsMap.set(result.accountId, [...existing, result.group]);
      }

      // Ensure all requested accounts have an entry (even if empty)
      for (const accountId of accountIds) {
        if (!groupsMap.has(accountId)) {
          groupsMap.set(accountId, []);
        }
      }

      return groupsMap;
    } catch (error) {
      this.logger.error({ error }, "Failed to find groups for accounts");
      throw error;
    }
  }
}
