import { bigint, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * A finished backup (SC-1649): the object a person downloads to restore
 * their data into an empty scani account. One row per stored object, so that
 * deleting the account deletes the object too — the deletion manifest echoes
 * `storage_key`, as it does `documents.r2_key`. The object holds every ledger
 * row and balance reading the account has, so it must not outlive the account.
 */
export const userBackups = pgTable(
  'user_backups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    formatVersion: integer('format_version').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    recordCount: integer('record_count').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCreatedIdx: index('idx_user_backups_user_created').on(table.userId, table.createdAt.desc()),
  })
);

export type UserBackup = typeof userBackups.$inferSelect;
