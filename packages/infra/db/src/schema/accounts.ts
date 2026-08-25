import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { entities } from './entities';
import { accountGroups } from './groups';
import { holdings } from './holdings';
import { institutions } from './institutions';
import { users } from './users';

// Dynamic enum table for account types — 'checking', 'savings',
// 'investment', 'wallet', etc. Admin-extensible without a migration.
export const accountTypes = pgTable('account_types', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: text('code').notNull().unique(), // 'checking', 'savings', etc.
  name: text('name').notNull(), // 'Checking Account', 'Savings Account', etc.
  description: text('description'),
  displayOrder: real('display_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Per-user financial accounts at an institution. Hidden accounts stay
// excluded from the UI but continue to be synced.
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    typeId: uuid('type_id')
      .notNull()
      .references(() => accountTypes.id, { onDelete: 'restrict' }),
    description: text('description'),
    // Which set of books this account belongs to (SC-463). NULL is a real
    // state, not a missing one: "not assigned to any entity". It is rendered
    // as its own bucket everywhere the per-entity totals are, so
    // `sum(entities) + unassigned === combined` holds exactly and no account
    // can be absorbed into a boundary nobody put it in.
    //
    // `set null` on delete, not `cascade`: deleting an entity must not delete
    // the accounts inside it, and must not take their holdings with it.
    entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'set null' }),
    metadata: jsonb('metadata').notNull().default('{}'), // Store wallet addresses and chain-specific data
    isHidden: boolean('is_hidden').notNull().default(false), // Hidden accounts excluded from UI but still synced
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueUserInstitutionAccountName: unique().on(table.userId, table.institutionId, table.name),
    userIdIdx: index('idx_accounts_user_id').on(table.userId),
    institutionIdIdx: index('idx_accounts_institution_id').on(table.institutionId),
    userInstitutionIdx: index('idx_accounts_user_institution').on(
      table.userId,
      table.institutionId
    ),
    userEntityIdx: index('idx_accounts_user_entity').on(table.userId, table.entityId),
  })
);

export const accountTypesRelations = relations(accountTypes, ({ many }) => ({
  accounts: many(accounts),
}));

export const accountsRelations = relations(accounts, ({ one, many }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
  institution: one(institutions, {
    fields: [accounts.institutionId],
    references: [institutions.id],
  }),
  type: one(accountTypes, {
    fields: [accounts.typeId],
    references: [accountTypes.id],
  }),
  entity: one(entities, {
    fields: [accounts.entityId],
    references: [entities.id],
  }),
  holdings: many(holdings),
  accountGroups: many(accountGroups),
}));

export type AccountType = typeof accountTypes.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
