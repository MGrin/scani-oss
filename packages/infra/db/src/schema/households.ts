import { sql } from 'drizzle-orm';
import { check, index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { tokens } from './tokens';
import { users } from './users';

/**
 * A household (SC-1647): people who share READ access to accounts each of
 * them chose to share. An account keeps exactly one owner; nothing here lets
 * a member write another member's rows. `created_by` is set null when its
 * user is deleted, because the household outlives its creator.
 */
export const households = pgTable('households', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  baseCurrencyId: uuid('base_currency_id')
    .notNull()
    .references(() => tokens.id),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One household per user in v1, which the unique `user_id` enforces. */
export const householdMembers = pgTable(
  'household_members',
  {
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .unique('household_members_user_uq')
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.householdId, t.userId] }),
    roleCheck: check('household_members_role_check', sql`${t.role} IN ('admin', 'member')`),
  })
);

/** The token is stored as its sha256 only, like a personal access token. */
export const householdInvites = pgTable(
  'household_invites',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull().unique('household_invites_token_hash_uq'),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    householdIdx: index('household_invites_household_idx').on(t.householdId),
  })
);

/** A row means the account is shared with the household; no row means private. */
export const accountShares = pgTable(
  'account_shares',
  {
    accountId: uuid('account_id')
      .primaryKey()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    level: text('level').notNull().default('view'),
    sharedBy: uuid('shared_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sharedAt: timestamp('shared_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    levelCheck: check('account_shares_level_check', sql`${t.level} = 'view'`),
    householdIdx: index('account_shares_household_idx').on(t.householdId),
  })
);

export type Household = typeof households.$inferSelect;
export type HouseholdMember = typeof householdMembers.$inferSelect;
export type HouseholdInvite = typeof householdInvites.$inferSelect;
export type AccountShare = typeof accountShares.$inferSelect;
