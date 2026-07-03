import { numeric, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

// Operator-entered actual monthly bills, one row per (period, provider).
// No vendor API exposes the authoritative past-month invoice total for
// Neon or Fly, so the operator records the real figure off each invoice
// on the admin Spend page; it supersedes the usage estimate for that
// provider+period. Previously an Upstash Redis hash
// (`admin:spend:overrides`); moved here when the Upstash database was
// retired (2026-07 cost reduction). Durable records — never expire.
export const adminSpendOverrides = pgTable(
  'admin_spend_overrides',
  {
    /** Billing month, `YYYY-MM`. */
    period: text('period').notNull(),
    /** Spend provider key (`fly`, `neon`, `upstash`, `cloudflare`, `sentry`). */
    provider: text('provider').notNull(),
    amountUsd: numeric('amount_usd', { precision: 12, scale: 2 }).notNull(),
    /** Free-form operator note, e.g. the vendor invoice number. */
    note: text('note'),
    /** `passkey:<credShort>:<sessionIat>` per the admin HMAC actor convention. */
    actor: text('actor').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.period, table.provider] }),
  })
);

export type AdminSpendOverride = typeof adminSpendOverrides.$inferSelect;
export type NewAdminSpendOverride = typeof adminSpendOverrides.$inferInsert;
