import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { Group, NewGroup } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Service } from 'typedi';

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
        .leftJoin(schema.holdingGroups, eq(schema.groups.id, schema.holdingGroups.groupId))
        .leftJoin(schema.accountGroups, eq(schema.groups.id, schema.accountGroups.groupId))
        .where(and(eq(schema.groups.userId, userId), eq(schema.groups.isActive, true)))
        .groupBy(
          schema.groups.id,
          schema.groups.userId,
          schema.groups.name,
          schema.groups.color,
          schema.groups.description,
          schema.groups.displayOrder,
          schema.groups.isActive,
          schema.groups.createdAt,
          schema.groups.updatedAt
        )
        .orderBy(schema.groups.displayOrder, schema.groups.name);

      return results as Array<
        Group & {
          holdingsCount: number;
          accountsCount: number;
        }
      >;
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

  /**
   * PERFORMANCE: Bulk assign groups to multiple accounts in a single transaction
   * Much more efficient than calling assignAccountGroups in a loop
   */
  async bulkAssignAccountGroups(
    accountIds: string[],
    groupIds: string[],
    transaction?: DatabaseTransaction
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
          }))
        );

        await database.insert(schema.accountGroups).values(values);
      }

      this.logger.debug(
        { accountCount: accountIds.length, groupCount: groupIds.length },
        'Bulk assigned account groups'
      );

      return { successCount: accountIds.length, failedCount: 0 };
    } catch (error) {
      this.logger.error({ accountIds, groupIds, error }, 'Failed to bulk assign account groups');
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
    transaction?: DatabaseTransaction
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
          }))
        );

        await database.insert(schema.holdingGroups).values(values);
      }

      this.logger.debug(
        { holdingCount: holdingIds.length, groupCount: groupIds.length },
        'Bulk assigned holding groups'
      );

      return { successCount: holdingIds.length, failedCount: 0 };
    } catch (error) {
      this.logger.error({ holdingIds, groupIds, error }, 'Failed to bulk assign holding groups');
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
   * Get groups for multiple holdings. Returns a map of holdingId → groups.
   *
   * IMPORTANT: Under the current group-assignment model, holdings are the
   * atomic unit of group membership. An account is "in" a group iff all
   * of its holdings are in that group. This function therefore returns
   * ONLY the direct holding→group rows from `holdingGroups`; it does NOT
   * inherit groups from the holding's account. Account-level membership
   * is a read-only projection of holding-level membership, cached in the
   * `accountGroups` table and updated via `recomputeAccountGroups`.
   *
   * An earlier version of this function combined holding groups with
   * account groups to show the "effective" group set on each holding.
   * That was the right thing under the old model (where accounts had
   * independent group membership that holdings inherited), but under the
   * new model it would double-count group membership and make the
   * accountGroups cache semantically meaningless.
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

      const holdingGroupsResults = await database
        .select({
          holdingId: schema.holdingGroups.holdingId,
          group: schema.groups,
        })
        .from(schema.holdingGroups)
        .innerJoin(schema.groups, eq(schema.holdingGroups.groupId, schema.groups.id))
        .where(inArray(schema.holdingGroups.holdingId, holdingIds));

      const groupsMap = new Map<string, Group[]>();
      for (const result of holdingGroupsResults) {
        const existing = groupsMap.get(result.holdingId) || [];
        groupsMap.set(result.holdingId, [...existing, result.group]);
      }
      // Ensure every requested holding has an entry (even empty) so
      // callers don't need to null-check the map lookup.
      for (const holding of holdings) {
        if (!groupsMap.has(holding.id)) {
          groupsMap.set(holding.id, []);
        }
      }

      return groupsMap;
    } catch (error) {
      this.logger.error({ error }, 'Failed to find groups for holdings');
      throw error;
    }
  }

  /**
   * Add a set of groups to a set of holdings (UNION, not REPLACE).
   *
   * `ON CONFLICT DO NOTHING` ensures we don't fail on the `(holdingId,
   * groupId)` unique constraint when a holding already has the group.
   *
   * Caller is responsible for calling `recomputeAccountGroups` for the
   * affected parent accounts afterwards if they want the `accountGroups`
   * cache to stay consistent with the new holding-group rows.
   */
  async bulkAddHoldingGroups(
    holdingIds: string[],
    groupIds: string[],
    transaction?: DatabaseTransaction
  ): Promise<void> {
    if (holdingIds.length === 0 || groupIds.length === 0) return;
    try {
      const database = this.getDb(transaction);
      const values = holdingIds.flatMap((holdingId) =>
        groupIds.map((groupId) => ({ holdingId, groupId }))
      );
      await database
        .insert(schema.holdingGroups)
        .values(values)
        .onConflictDoNothing({
          target: [schema.holdingGroups.holdingId, schema.holdingGroups.groupId],
        });
    } catch (error) {
      this.logger.error({ holdingIds, groupIds, error }, 'Failed to bulk add holding groups');
      throw error;
    }
  }

  /**
   * Remove a set of groups from a set of holdings. No-op for pairs that
   * don't exist.
   *
   * Caller is responsible for calling `recomputeAccountGroups` afterwards
   * for the affected parent accounts.
   */
  async bulkRemoveHoldingGroups(
    holdingIds: string[],
    groupIds: string[],
    transaction?: DatabaseTransaction
  ): Promise<void> {
    if (holdingIds.length === 0 || groupIds.length === 0) return;
    try {
      const database = this.getDb(transaction);
      await database
        .delete(schema.holdingGroups)
        .where(
          and(
            inArray(schema.holdingGroups.holdingId, holdingIds),
            inArray(schema.holdingGroups.groupId, groupIds)
          )
        );
    } catch (error) {
      this.logger.error({ holdingIds, groupIds, error }, 'Failed to bulk remove holding groups');
      throw error;
    }
  }

  /**
   * Recompute the `accountGroups` cache for a set of accounts.
   *
   * An account is considered "in" a group G iff every one of its
   * visible holdings (active AND not hidden) is in G. This matches the
   * user-facing model: hiding a holding removes it from consideration
   * in every place it shows up in the UI, including group membership.
   *
   * The SQL below:
   *   1. Deletes all existing `accountGroups` rows for the given
   *      accountIds (unconditional cache invalidation for those rows).
   *   2. Re-inserts rows for every (account, group) pair where all of
   *      that account's visible holdings are in that group.
   *
   * The `HAVING` clause does the "all holdings of the account are in
   * this group" check by counting distinct holdings in the join and
   * comparing to the total number of visible holdings on the account.
   * Accounts with zero visible holdings produce no rows, so they end
   * up in no groups — the intuitive edge case.
   */
  async recomputeAccountGroups(
    accountIds: string[],
    transaction?: DatabaseTransaction
  ): Promise<void> {
    if (accountIds.length === 0) return;
    try {
      const database = this.getDb(transaction);

      // Step 1: clear the cache rows we're about to rebuild.
      await database
        .delete(schema.accountGroups)
        .where(inArray(schema.accountGroups.accountId, accountIds));

      // Step 2: rebuild. One statement covers every account in the list.
      // We use a raw `sql` template because the HAVING clause needs a
      // correlated subquery that drizzle's fluent API would make
      // awkward to express.
      const accountIdsLiteral = sql.join(
        accountIds.map((id) => sql`${id}::uuid`),
        sql`, `
      );
      // "Visible" here means non-hidden only. Inactive holdings are still
      // user-visible (they're just excluded from the aggregated portfolio
      // value) so they must count toward the "every visible holding is in
      // this group" rule — otherwise an account whose sole holding is
      // inactive could never be added to a group, because the account
      // would appear to have zero countable holdings after the filter.
      await database.execute(sql`
        INSERT INTO account_groups (account_id, group_id)
        SELECT h.account_id, hg.group_id
        FROM holding_groups hg
        INNER JOIN holdings h
          ON h.id = hg.holding_id
         AND h.is_hidden = false
        WHERE h.account_id IN (${accountIdsLiteral})
        GROUP BY h.account_id, hg.group_id
        HAVING COUNT(DISTINCT hg.holding_id) = (
          SELECT COUNT(*)
          FROM holdings sub
          WHERE sub.account_id = h.account_id
            AND sub.is_hidden = false
        )
      `);
    } catch (error) {
      this.logger.error({ accountIds, error }, 'Failed to recompute account groups');
      throw error;
    }
  }

  /**
   * Find the parent account IDs for a set of holding IDs. Used by callers
   * who need to invoke `recomputeAccountGroups` after changing
   * `holdingGroups` rows.
   */
  async findParentAccountIdsForHoldings(
    holdingIds: string[],
    transaction?: DatabaseTransaction
  ): Promise<string[]> {
    if (holdingIds.length === 0) return [];
    try {
      const database = this.getDb(transaction);
      const rows = await database
        .selectDistinct({ accountId: schema.holdings.accountId })
        .from(schema.holdings)
        .where(inArray(schema.holdings.id, holdingIds));
      return rows.map((r) => r.accountId);
    } catch (error) {
      this.logger.error({ holdingIds, error }, 'Failed to find parent accounts for holdings');
      throw error;
    }
  }

  /**
   * Find all visible holding IDs that belong to a set of accounts.
   * Used when the caller wants to propagate an account-level group
   * operation down to the underlying holdings. "Visible" here means
   * non-hidden — inactive holdings are still visible in the UI (they
   * just don't contribute to the aggregated portfolio value) so they
   * must be included, otherwise assigning a group to an account that
   * only has inactive holdings would be a silent no-op.
   */
  async findVisibleHoldingIdsForAccounts(
    accountIds: string[],
    transaction?: DatabaseTransaction
  ): Promise<string[]> {
    if (accountIds.length === 0) return [];
    try {
      const database = this.getDb(transaction);
      const rows = await database
        .select({ id: schema.holdings.id })
        .from(schema.holdings)
        .where(
          and(inArray(schema.holdings.accountId, accountIds), eq(schema.holdings.isHidden, false))
        );
      return rows.map((r) => r.id);
    } catch (error) {
      this.logger.error({ accountIds, error }, 'Failed to find holdings for accounts');
      throw error;
    }
  }

  /**
   * Find groups for multiple accounts
   * Returns a map of accountId -> groups array
   */
  async findGroupsForAccounts(
    accountIds: string[],
    transaction?: DatabaseTransaction
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
        .innerJoin(schema.groups, eq(schema.accountGroups.groupId, schema.groups.id))
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
      this.logger.error({ error }, 'Failed to find groups for accounts');
      throw error;
    }
  }
}
