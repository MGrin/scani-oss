import { sql } from 'drizzle-orm';
import {
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users';

// A person's transaction categories, one level deep (SC-1652). The depth
// trigger, and the parent key's `ON DELETE SET NULL (parent_id)`, live in
// migration 20261010054834; drizzle cannot express either.
export const transactionCategories = pgTable(
  'transaction_categories',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
    color: text('color'),
    displayOrder: integer('display_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idUserUq: unique('transaction_categories_id_user_uq').on(table.id, table.userId),
    parentFk: foreignKey({
      name: 'transaction_categories_parent_fk',
      columns: [table.parentId, table.userId],
      foreignColumns: [table.id, table.userId],
    }),
    nameUq: uniqueIndex('transaction_categories_name_uq').on(
      table.userId,
      sql`coalesce(${table.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`lower(${table.name})`
    ),
  })
);

// What the AI answered for a payee key, so a key is asked once (SC-1695).
// `category_id` NULL is a remembered "no clear match". Deleting the category
// deletes the answer, so that key is asked again.
export const transactionCategoryAiAnswers = pgTable(
  'transaction_category_ai_answers',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    payeeKey: text('payee_key').notNull(),
    categoryId: uuid('category_id').references(() => transactionCategories.id, {
      onDelete: 'cascade',
    }),
    askedAt: timestamp('asked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.payeeKey] }),
    categoryIdx: index('idx_tx_category_ai_answers_category').on(table.categoryId),
  })
);

export type TransactionCategory = typeof transactionCategories.$inferSelect;
export type NewTransactionCategory = typeof transactionCategories.$inferInsert;
