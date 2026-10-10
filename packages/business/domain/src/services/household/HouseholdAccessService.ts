import { type DatabaseTransaction, getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { and, asc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Service } from 'typedi';

export type HouseholdRole = 'admin' | 'member';

export interface HouseholdMembership {
  householdId: string;
  name: string;
  role: HouseholdRole;
  baseCurrencyId: string;
}

export interface VisibleAccount {
  accountId: string;
  ownerId: string;
  /** The owner's name, or their email when the name is empty. */
  ownerName: string;
  ownedByViewer: boolean;
}

/**
 * The one answer to "which accounts may this viewer read through the household"
 * (SC-1647). Every household read takes its account ids from here and nothing
 * else: each leak in Sure's households was a path that forgot this filter.
 */
@Service()
export class HouseholdAccessService {
  async membershipOf(
    userId: string,
    tx?: DatabaseTransaction
  ): Promise<HouseholdMembership | null> {
    const db = tx ?? getDb();
    const [row] = await db
      .select({
        householdId: schema.households.id,
        name: schema.households.name,
        role: schema.householdMembers.role,
        baseCurrencyId: schema.households.baseCurrencyId,
      })
      .from(schema.householdMembers)
      .innerJoin(schema.households, eq(schema.households.id, schema.householdMembers.householdId))
      .where(eq(schema.householdMembers.userId, userId))
      .limit(1);
    if (!row) return null;
    return { ...row, role: row.role as HouseholdRole };
  }

  /**
   * Every account shared into the viewer's household, the viewer's own shares
   * included. Empty when the viewer belongs to no household.
   */
  async visibleAccounts(viewerId: string, tx?: DatabaseTransaction): Promise<VisibleAccount[]> {
    const db = tx ?? getDb();
    const viewer = alias(schema.householdMembers, 'viewer');
    const owner = alias(schema.householdMembers, 'owner');
    const ownerName = sql<string>`coalesce(nullif(${schema.users.name}, ''), ${schema.users.email})`;
    const rows = await db
      .select({
        accountId: schema.accounts.id,
        ownerId: schema.accounts.userId,
        ownerName,
      })
      .from(viewer)
      .innerJoin(schema.accountShares, eq(schema.accountShares.householdId, viewer.householdId))
      .innerJoin(
        schema.accounts,
        and(
          eq(schema.accounts.id, schema.accountShares.accountId),
          eq(schema.accounts.userId, schema.accountShares.sharedBy)
        )
      )
      // The owner must still belong to the household: a share outlived by its
      // owner's membership never reaches anyone.
      .innerJoin(
        owner,
        and(eq(owner.householdId, viewer.householdId), eq(owner.userId, schema.accounts.userId))
      )
      .innerJoin(schema.users, eq(schema.users.id, schema.accounts.userId))
      .where(eq(viewer.userId, viewerId))
      .orderBy(asc(ownerName), asc(schema.accounts.name), asc(schema.accounts.id));
    return rows.map((row) => ({ ...row, ownedByViewer: row.ownerId === viewerId }));
  }
}
