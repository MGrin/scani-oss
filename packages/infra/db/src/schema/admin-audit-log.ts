import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Records operator-initiated mutations from the admin app — BullMQ
// retry/remove, DLQ replay, etc. See migration 0045. Append-only;
// `actor` is the admin's email-or-name; `result` is 'success'|'failure'
// (free-text for now); `details` is jsonb for any per-action payload.
//
// Tamper-evidence (migration 0014):
//   * `prev_signature` chains to the previous row's `signature` so a
//     deleted middle row is detectable from the chain break.
//   * `signature` is HMAC-SHA256 over the row's logical fields
//     (id, actor, action, resource, result, details, createdAt,
//     prev_signature) using `ADMIN_JOBS_HMAC_SECRET` as the key.
//   * The first row of the table has `prev_signature = ''` by
//     convention; auditors verify the chain by recomputing HMAC
//     for each row in createdAt order and confirming it matches the
//     stored `signature`, AND that each row's `prev_signature`
//     equals the previous row's `signature`.
export const adminAuditLog = pgTable(
  'admin_audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    resource: text('resource').notNull(),
    result: text('result').notNull(),
    details: jsonb('details'),
    // Hex-encoded HMAC-SHA256 of the canonical row payload. Nullable
    // so historical rows written before the chain landed remain
    // valid (the verifier treats null-signature rows as "pre-chain"
    // and starts chain validation from the first signed row).
    prevSignature: text('prev_signature'),
    signature: text('signature'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    createdAtIdx: index('admin_audit_log_created_at_idx').on(table.createdAt),
  })
);

export type AdminAuditLog = typeof adminAuditLog.$inferSelect;
export type NewAdminAuditLog = typeof adminAuditLog.$inferInsert;
