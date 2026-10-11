import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { holdingTransactions } from './holdings';
import { users } from './users';

/**
 * One upload of a budget app's register (SC-1649), kept so it can be undone:
 * the accounts it created and, below, every ledger row it inserted. A row a
 * later upload re-sent is not its, so undoing one upload never takes another's.
 */
export const budgetAppImports = pgTable(
  'budget_app_imports',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    app: text('app').notNull(),
    uploadRef: text('upload_ref').notNull(),
    createdAccountIds: uuid('created_account_ids').array().notNull().default([]),
    /** Rows read, written, paired and skipped, with reasons: the result the person saw. */
    summary: jsonb('summary').notNull(),
    undoneAt: timestamp('undone_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCreatedIdx: index('idx_budget_app_imports_user_created').on(
      table.userId,
      table.createdAt.desc()
    ),
  })
);

export const budgetAppImportEntries = pgTable(
  'budget_app_import_entries',
  {
    importId: uuid('import_id')
      .notNull()
      .references(() => budgetAppImports.id, { onDelete: 'cascade' }),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => holdingTransactions.id, { onDelete: 'cascade' }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.importId, table.transactionId] }),
    transactionIdx: index('idx_budget_app_import_entries_transaction').on(table.transactionId),
  })
);

export type BudgetAppImport = typeof budgetAppImports.$inferSelect;
