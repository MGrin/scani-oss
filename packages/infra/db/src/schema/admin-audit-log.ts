import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Records operator-initiated mutations from the admin app — BullMQ
// retry/remove, DLQ replay, etc. See migration 0045. Append-only;
// `actor` is the admin's email-or-name; `result` is 'success'|'failure'
// (free-text for now); `details` is jsonb for any per-action payload.
export const adminAuditLog = pgTable(
  'admin_audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    resource: text('resource').notNull(),
    result: text('result').notNull(),
    details: jsonb('details'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    createdAtIdx: index('admin_audit_log_created_at_idx').on(table.createdAt),
  })
);

export type AdminAuditLog = typeof adminAuditLog.$inferSelect;
export type NewAdminAuditLog = typeof adminAuditLog.$inferInsert;
