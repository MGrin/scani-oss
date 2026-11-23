import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { transactionCategories } from './transaction-categories';
import { users } from './users';

export const transactionCategoryRules = pgTable(
  'transaction_category_rules',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').notNull(),
    payeeKey: text('payee_key').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scopeUnique: unique('transaction_category_rules_scope_uq').on(
      t.userId,
      t.accountId,
      t.payeeKey
    ),
    categoryFk: foreignKey({
      name: 'transaction_category_rules_category_fk',
      columns: [t.categoryId, t.userId],
      foreignColumns: [transactionCategories.id, transactionCategories.userId],
    }).onDelete('restrict'),
    categoryIdx: index('transaction_category_rules_category_idx').on(t.categoryId, t.userId),
    revisionCheck: check('transaction_category_rules_revision_check', sql`${t.revision} > 0`),
  })
);
export const transactionCategoryRuleRuns = pgTable(
  'transaction_category_rule_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').$type<'preview' | 'applied' | 'undone'>().notNull().default('preview'),
    projectionVersion: integer('projection_version').notNull().default(1),
    scope: jsonb('scope').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    candidateIds: jsonb('candidate_ids').$type<string[]>().notNull(),
    changedIds: jsonb('changed_ids').$type<string[]>().notNull(),
    candidates: jsonb('candidates').notNull(),
    result: jsonb('result'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    undoneAt: timestamp('undone_at', { withTimezone: true }),
  },
  (t) => ({
    ownerIdx: index('transaction_category_rule_runs_owner_idx').on(t.userId, t.appliedAt, t.id),
    statusCheck: check(
      'transaction_category_rule_runs_status_check',
      sql`${t.status} in ('preview', 'applied', 'undone')`
    ),
    boundCheck: check(
      'transaction_category_rule_runs_bound_check',
      sql`jsonb_array_length(${t.candidateIds}) <= 500 and jsonb_array_length(${t.changedIds}) <= 500`
    ),
  })
);
