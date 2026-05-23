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
  holdings: many(holdings),
  accountGroups: many(accountGroups),
}));

export type AccountType = typeof accountTypes.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
