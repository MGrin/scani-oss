import { relations } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

// One alert already claimed or delivered to one account (SC-459).
//
// A row is the answer to "have we told them this?" — and its ABSENCE is the
// answer to "has it cleared?". The sweep deletes rows whose condition no longer
// holds, so a fault that comes back alerts again, and a fault that persists for
// six weeks alerts once.
//
// `sentAt` NULL means claimed-but-not-yet-delivered. The claim is written
// BEFORE the send so a crash mid-send suppresses rather than duplicates; a
// claim older than `ALERT_CLAIM_TTL_MS` is treated as abandoned and retaken.
export const alertDeliveries = pgTable(
  'alert_deliveries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // The named rule, e.g. `integration-stale`. Text, not an enum: a rule is
    // added by a deploy, and an enum would make that a migration.
    rule: text('rule').notNull(),
    // What, within that rule, this alert was about — a credential id here, a
    // holding and a date for the next rule. Opaque to everything but the rule
    // that minted it.
    dedupeKey: text('dedupe_key').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_alert_deliveries_identity').on(table.userId, table.rule, table.dedupeKey),
    index('idx_alert_deliveries_rule').on(table.rule),
  ]
);

export const alertDeliveriesRelations = relations(alertDeliveries, ({ one }) => ({
  user: one(users, {
    fields: [alertDeliveries.userId],
    references: [users.id],
  }),
}));

export type AlertDelivery = typeof alertDeliveries.$inferSelect;
export type NewAlertDelivery = typeof alertDeliveries.$inferInsert;
