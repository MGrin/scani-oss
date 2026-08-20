import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { Group, NewGroup } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Service } from 'typedi';
import { SCAM_PROBABILITY_THRESHOLD } from '../lib/constants';

/**
 * Groups, and the three states a (holding, group) pair can be in.
 *
 * Membership is a **standing rule**, chosen by mgrin on 2026-08-18 over the
 * snapshot semantic SC-385 had measured and taken the other side of. Adding an
 * account to a group means that account is in the group permanently — what it
 * holds now and everything it receives later. So:
 *
 *   1. **in by its own row** — `holding_groups`
 *   2. **in via its account** — `account_groups` on the holding's `account_id`
 *   3. **explicitly out** — `holding_group_exclusions`, which beats both
 *
 * and every read of membership resolves the same expression, in
 * `resolveMembership` and nowhere else:
 *
 *     (holding_groups ∪ inherited) − exclusions
 *
 * The third state is what makes the first two survivable. Six of these wallets
 * receive airdrops continuously; a rule with nothing to oppose it would drag
 * every one of them into the group, scam dust included. The veto is what the
 * user reaches for instead of ungrouping the whole account.
 *
 * `account_groups` is therefore no longer a cache and `recomputeAccountGroups`
 * is gone: under a live rule there is nothing to recompute, and the eight rows
 * that were stale on production are true again because the rule that wrote them
 * is now the rule that reads them (SC-386).
 */
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
          // The same three states `resolveMembership` reads, as one scalar
          // subquery per group — counting `holding_groups` rows alone would
          // now undercount every holding that is in by its account's rule.
          //
          // Hidden and scam-flagged holdings are left out so the number
          // matches the list it labels: `findByUserWithFullDetails` filters
          // both, so the group's page cannot show them however they are
          // grouped. The scam half was missing until SC-388, which is a
          // fourth number on a screen that already had three.
          //
          // `::int` is load-bearing: COUNT returns bigint, and postgres.js
          // hands bigint back as a decimal string because a JS number cannot
          // hold its full range. Without the cast the field is typed `number`
          // and delivered as `"1"`, which is how the groups list came to read
          // "1 holdings" (SC-88).
          //
          // The outer table is spelled out rather than interpolated: drizzle
          // renders a column passed into a `sql` template in the SELECT list
          // UNQUALIFIED (`"id"`, not `"groups"."id"`), and inside a correlated
          // subquery that binds to the SUBQUERY's own table instead. It does
          // not error — `hg.group_id = "id"` is a valid comparison against
          // `holdings.id` — it just counts zero, forever.
          holdingsCount: sql<number>`(
            SELECT COUNT(*)::int
            FROM holdings h
            JOIN tokens tk ON tk.id = h.token_id
            WHERE h.user_id = "groups"."user_id"
              AND h.is_hidden = false
              AND tk.is_scam_probability < ${SCAM_PROBABILITY_THRESHOLD}
              AND (
                EXISTS (
                  SELECT 1 FROM holding_groups hg
                  WHERE hg.holding_id = h.id AND hg.group_id = "groups"."id"
                )
                OR EXISTS (
                  SELECT 1 FROM account_groups ag
                  WHERE ag.account_id = h.account_id AND ag.group_id = "groups"."id"
                )
              )
              AND NOT EXISTS (
                SELECT 1 FROM holding_group_exclusions ex
                WHERE ex.holding_id = h.id AND ex.group_id = "groups"."id"
              )
          )`,
          accountsCount: sql<number>`(
            SELECT COUNT(*)::int
            FROM account_groups ag
            WHERE ag.group_id = "groups"."id"
          )`,
        })
        .from(schema.groups)
        .where(and(eq(schema.groups.userId, userId), eq(schema.groups.isActive, true)))
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

  /**
   * The one place the three states are resolved into an answer.
   *
   * Three indexed reads rather than one query with correlated subqueries in a
   * join: the expression is `(direct ∪ inherited) − vetoed`, and written this
   * way the code says that and can be checked against it. They run in sequence
   * because a caller may hand us a transaction, and a transaction is one
   * connection.
   *
   * Every requested holding gets an entry, empty array included, so callers
   * never have to distinguish "no groups" from "not in the map".
   */
  private async resolveMembership(
    holdingIds: string[],
    transaction?: DatabaseTransaction
  ): Promise<Map<string, Group[]>> {
    const out = new Map<string, Group[]>();
    for (const id of holdingIds) out.set(id, []);
    if (holdingIds.length === 0) return out;

    const database = this.getDb(transaction);

    const direct = await database
      .select({ holdingId: schema.holdingGroups.holdingId, group: schema.groups })
      .from(schema.holdingGroups)
      .innerJoin(schema.groups, eq(schema.holdingGroups.groupId, schema.groups.id))
      .where(inArray(schema.holdingGroups.holdingId, holdingIds));

    const inherited = await database
      .select({ holdingId: schema.holdings.id, group: schema.groups })
      .from(schema.holdings)
      .innerJoin(
        schema.accountGroups,
        eq(schema.accountGroups.accountId, schema.holdings.accountId)
      )
      .innerJoin(schema.groups, eq(schema.accountGroups.groupId, schema.groups.id))
      .where(inArray(schema.holdings.id, holdingIds));

    const vetoed = await database
      .select({
        holdingId: schema.holdingGroupExclusions.holdingId,
        groupId: schema.holdingGroupExclusions.groupId,
      })
      .from(schema.holdingGroupExclusions)
      .where(inArray(schema.holdingGroupExclusions.holdingId, holdingIds));

    const excluded = new Set(vetoed.map((row) => `${row.holdingId}:${row.groupId}`));
    const seen = new Set<string>();
    for (const row of [...direct, ...inherited]) {
      const key = `${row.holdingId}:${row.group.id}`;
      // A holding can be reached by both paths — its own row AND its account's
      // rule — and is still in the group exactly once.
      if (seen.has(key) || excluded.has(key)) continue;
      seen.add(key);
      out.get(row.holdingId)?.push(row.group);
    }
    return out;
  }

  async findGroupsByHoldingId(
    holdingId: string,
    transaction?: DatabaseTransaction
  ): Promise<Group[]> {
    try {
      const resolved = await this.resolveMembership([holdingId], transaction);
      return resolved.get(holdingId) ?? [];
    } catch (error) {
      this.logger.error({ holdingId, error }, 'Failed to find groups by holding');
      throw error;
    }
  }

  /**
   * Batch lookup of groups for many holdings, with ownership-scoped filtering.
   *
   * Holdings the user doesn't own are silently absent from the returned map;
   * callers can detect that as `result.has(id) === false`. Owned holdings with
   * no groups are present with an empty array.
   */
  async findGroupsByHoldingIds(
    userId: string,
    holdingIds: string[],
    transaction?: DatabaseTransaction
  ): Promise<Map<string, Group[]>> {
    const out = new Map<string, Group[]>();
    if (holdingIds.length === 0) return out;
    try {
      const database = this.getDb(transaction);
      const owned = await database
        .select({ id: schema.holdings.id })
        .from(schema.holdings)
        .where(and(eq(schema.holdings.userId, userId), inArray(schema.holdings.id, holdingIds)));
      const ownedIds = owned.map((row) => row.id);
      if (ownedIds.length === 0) return out;
      return await this.resolveMembership(ownedIds, transaction);
    } catch (error) {
      this.logger.error(
        { userId, count: holdingIds.length, error },
        'Failed to batch-find groups by holdings'
      );
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

  /**
   * Groups for multiple holdings, as a `Map<holdingId, Group[]>`.
   *
   * The one membership resolution SC-385 collapsed the surfaces onto: this is
   * what `holdings.getWithDetails` puts on the wire AND what
   * `GroupValuationService` sums, so the allocation card and the holdings list
   * it opens cannot answer "who is in this group" differently. SC-386 changed
   * what the answer IS — it now includes the account's standing rule, minus any
   * per-holding veto — without splitting it back into two readings.
   *
   * `accountId` is taken but not read: the account's rule is joined through
   * `holdings.account_id`, so a caller cannot hand us a stale parent.
   */
  async findGroupsForHoldings(
    holdings: Array<{ id: string; accountId: string }>,
    transaction?: DatabaseTransaction
  ): Promise<Map<string, Group[]>> {
    try {
      return await this.resolveMembership(
        holdings.map((holding) => holding.id),
        transaction
      );
    } catch (error) {
      this.logger.error({ error }, 'Failed to find groups for holdings');
      throw error;
    }
  }

  /**
   * Every holding that is in one of these groups, by any of the three states.
   * Ownership-scoped, for the account-data export — which would otherwise
   * describe a group by its explicit rows alone and omit both what the standing
   * rule pulls in and what a veto keeps out.
   */
  async findHoldingIdsByGroupIds(
    userId: string,
    groupIds: string[],
    transaction?: DatabaseTransaction
  ): Promise<Array<{ groupId: string; holdingId: string }>> {
    if (groupIds.length === 0) return [];
    try {
      const database = this.getDb(transaction);
      const rows = await database
        .select({ id: schema.holdings.id })
        .from(schema.holdings)
        .where(and(eq(schema.holdings.userId, userId), eq(schema.holdings.isHidden, false)));
      const resolved = await this.resolveMembership(
        rows.map((row) => row.id),
        transaction
      );
      const wanted = new Set(groupIds);
      const out: Array<{ groupId: string; holdingId: string }> = [];
      for (const [holdingId, groups] of resolved) {
        for (const group of groups) {
          if (wanted.has(group.id)) out.push({ groupId: group.id, holdingId });
        }
      }
      return out;
    } catch (error) {
      this.logger.error({ userId, groupIds, error }, 'Failed to find holdings by groups');
      throw error;
    }
  }

  /**
   * Put a set of holdings in a set of groups (UNION, not REPLACE).
   *
   * Also **clears any veto** on those pairs, which is the undo of
   * `bulkRemoveHoldingGroups` — without it a holding excluded once could never
   * be put back, because its account's rule would keep being overridden by a
   * row the user has no other way to reach.
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
      await database
        .delete(schema.holdingGroupExclusions)
        .where(
          and(
            inArray(schema.holdingGroupExclusions.holdingId, holdingIds),
            inArray(schema.holdingGroupExclusions.groupId, groupIds)
          )
        );
    } catch (error) {
      this.logger.error({ holdingIds, groupIds, error }, 'Failed to bulk add holding groups');
      throw error;
    }
  }

  /**
   * Take a set of holdings out of a set of groups.
   *
   * Deleting the `holding_groups` row is only half of it now: if the holding's
   * account is in the group, the standing rule would put it straight back, and
   * the remove would read to the user as an action that did nothing. So a veto
   * is written for exactly those pairs — and for no others, because a veto on a
   * pair nothing puts together is an assertion with no referent, and it would
   * silently outrank a later "add this whole account".
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
      const holdingIdsLiteral = sql.join(
        holdingIds.map((id) => sql`${id}::uuid`),
        sql`, `
      );
      const groupIdsLiteral = sql.join(
        groupIds.map((id) => sql`${id}::uuid`),
        sql`, `
      );
      await database.execute(sql`
        INSERT INTO holding_group_exclusions (holding_id, group_id)
        SELECT h.id, ag.group_id
        FROM holdings h
        INNER JOIN account_groups ag ON ag.account_id = h.account_id
        WHERE h.id IN (${holdingIdsLiteral})
          AND ag.group_id IN (${groupIdsLiteral})
        ON CONFLICT (holding_id, group_id) DO NOTHING
      `);
    } catch (error) {
      this.logger.error({ holdingIds, groupIds, error }, 'Failed to bulk remove holding groups');
      throw error;
    }
  }

  /**
   * Put a set of accounts in a set of groups — the standing rule itself.
   *
   * Clears every veto those accounts' holdings carry for those groups. Adding
   * an account is a fresh assertion about the whole of it, so it has to be
   * total: otherwise re-adding an account would quietly not re-add the
   * positions the user vetoed months ago, and there would be no bulk way back.
   */
  async addAccountGroups(
    accountIds: string[],
    groupIds: string[],
    transaction?: DatabaseTransaction
  ): Promise<void> {
    if (accountIds.length === 0 || groupIds.length === 0) return;
    try {
      const database = this.getDb(transaction);
      const values = accountIds.flatMap((accountId) =>
        groupIds.map((groupId) => ({ accountId, groupId }))
      );
      await database
        .insert(schema.accountGroups)
        .values(values)
        .onConflictDoNothing({
          target: [schema.accountGroups.accountId, schema.accountGroups.groupId],
        });
      await this.clearExclusionsForAccounts(accountIds, groupIds, transaction);
    } catch (error) {
      this.logger.error({ accountIds, groupIds, error }, 'Failed to add account groups');
      throw error;
    }
  }

  /**
   * Take a set of accounts out of a set of groups.
   *
   * "This account is not in this group" has to be total, so the holdings' own
   * rows go too. Most of them were written by the cascade this model replaced —
   * leaving them would mean removing the account changed nothing visible, which
   * is the mirror image of the bug SC-385 found. The vetoes go with them: a
   * veto only means anything while the rule it opposes is in force.
   */
  async removeAccountGroups(
    accountIds: string[],
    groupIds: string[],
    transaction?: DatabaseTransaction
  ): Promise<void> {
    if (accountIds.length === 0 || groupIds.length === 0) return;
    try {
      const database = this.getDb(transaction);
      await database
        .delete(schema.accountGroups)
        .where(
          and(
            inArray(schema.accountGroups.accountId, accountIds),
            inArray(schema.accountGroups.groupId, groupIds)
          )
        );
      const accountIdsLiteral = sql.join(
        accountIds.map((id) => sql`${id}::uuid`),
        sql`, `
      );
      const groupIdsLiteral = sql.join(
        groupIds.map((id) => sql`${id}::uuid`),
        sql`, `
      );
      await database.execute(sql`
        DELETE FROM holding_groups hg
        USING holdings h
        WHERE hg.holding_id = h.id
          AND h.account_id IN (${accountIdsLiteral})
          AND hg.group_id IN (${groupIdsLiteral})
      `);
      await this.clearExclusionsForAccounts(accountIds, groupIds, transaction);
    } catch (error) {
      this.logger.error({ accountIds, groupIds, error }, 'Failed to remove account groups');
      throw error;
    }
  }

  private async clearExclusionsForAccounts(
    accountIds: string[],
    groupIds: string[],
    transaction?: DatabaseTransaction
  ): Promise<void> {
    const database = this.getDb(transaction);
    const accountIdsLiteral = sql.join(
      accountIds.map((id) => sql`${id}::uuid`),
      sql`, `
    );
    const groupIdsLiteral = sql.join(
      groupIds.map((id) => sql`${id}::uuid`),
      sql`, `
    );
    await database.execute(sql`
      DELETE FROM holding_group_exclusions ex
      USING holdings h
      WHERE ex.holding_id = h.id
        AND h.account_id IN (${accountIdsLiteral})
        AND ex.group_id IN (${groupIdsLiteral})
    `);
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
