import { relations } from 'drizzle-orm';
import { boolean, index, pgTable, real, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { holdings } from './holdings';
import { users } from './users';

// User-defined custom groups for organizing holdings and accounts.
// Distinct from system labels — these are user-named buckets ("Crypto",
// "Retirement", "Side projects") with a hex color for the UI.
export const groups = pgTable(
  'groups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull(), // Hex color code (e.g., '#3b82f6')
    description: text('description'),
    displayOrder: real('display_order').notNull().default(0), // For custom ordering
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueUserGroupName: unique().on(table.userId, table.name),
    userIdIdx: index('idx_groups_user_id').on(table.userId),
    displayOrderIdx: index('idx_groups_display_order').on(table.userId, table.displayOrder),
  })
);

// Junction: many-to-many between holdings and groups.
export const holdingGroups = pgTable(
  'holding_groups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    holdingId: uuid('holding_id')
      .notNull()
      .references(() => holdings.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueHoldingGroup: unique().on(table.holdingId, table.groupId),
    holdingIdIdx: index('idx_holding_groups_holding_id').on(table.holdingId),
    groupIdIdx: index('idx_holding_groups_group_id').on(table.groupId),
  })
);

// Junction: many-to-many between accounts and groups.
export const accountGroups = pgTable(
  'account_groups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueAccountGroup: unique().on(table.accountId, table.groupId),
    accountIdIdx: index('idx_account_groups_account_id').on(table.accountId),
    groupIdIdx: index('idx_account_groups_group_id').on(table.groupId),
  })
);

export const groupsRelations = relations(groups, ({ one, many }) => ({
  user: one(users, {
    fields: [groups.userId],
    references: [users.id],
  }),
  holdingGroups: many(holdingGroups),
  accountGroups: many(accountGroups),
}));

export const holdingGroupsRelations = relations(holdingGroups, ({ one }) => ({
  holding: one(holdings, {
    fields: [holdingGroups.holdingId],
    references: [holdings.id],
  }),
  group: one(groups, {
    fields: [holdingGroups.groupId],
    references: [groups.id],
  }),
}));

export const accountGroupsRelations = relations(accountGroups, ({ one }) => ({
  account: one(accounts, {
    fields: [accountGroups.accountId],
    references: [accounts.id],
  }),
  group: one(groups, {
    fields: [accountGroups.groupId],
    references: [groups.id],
  }),
}));

export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;
export type HoldingGroup = typeof holdingGroups.$inferSelect;
export type NewHoldingGroup = typeof holdingGroups.$inferInsert;
export type AccountGroup = typeof accountGroups.$inferSelect;
export type NewAccountGroup = typeof accountGroups.$inferInsert;
