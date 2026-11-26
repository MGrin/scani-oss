import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { tokens } from './tokens';
import { transactionCategories } from './transaction-categories';
import { users } from './users';

export const monthlyCategoryBudgets = pgTable(
  'monthly_category_budgets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').notNull(),
    requiresRoot: boolean('requires_root').notNull().default(true),
    tokenId: uuid('token_id')
      .notNull()
      .references(() => tokens.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    month: date('month', { mode: 'string' }).notNull(),
    limit: text('limit').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tuple: unique('monthly_category_budgets_tuple_uq').on(
      t.userId,
      t.month,
      t.categoryId,
      t.tokenId
    ),
    rootFk: foreignKey({
      name: 'monthly_category_budgets_root_fk',
      columns: [t.categoryId, t.userId, t.requiresRoot],
      foreignColumns: [
        transactionCategories.id,
        transactionCategories.userId,
        transactionCategories.budgetRoot,
      ],
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    root: check('monthly_category_budgets_requires_root_check', sql`${t.requiresRoot} = true`),
    month: check(
      'monthly_category_budgets_month_check',
      sql`${t.month} >= date '1900-01-01' and extract(day from ${t.month}) = 1 and ${t.month} <= date_trunc('month', now() at time zone 'UTC')::date`
    ),
    amount: check(
      'monthly_category_budgets_limit_check',
      sql`${t.limit} ~ '^[0-9]{1,15}(\\.[0-9]{1,18})?$'`
    ),
  })
);
