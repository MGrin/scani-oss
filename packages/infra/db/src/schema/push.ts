import { relations } from 'drizzle-orm';
import { index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * A Web Push endpoint — one row per browser per device (SC-226).
 *
 * A person with the PWA installed on a phone and open on a laptop has two
 * rows, and both should receive. That is why the identity here is the
 * endpoint rather than the user: the push service issues one per
 * subscription, it is already unique, and it is what a delete has to match
 * when the service answers 404 or 410 to say the subscription is gone.
 *
 * `p256dh` and `auth` are the client's public key halves. They are not
 * credentials of ours — Web Push encrypts *to* them — but they identify a
 * device and are treated as personal data: deleted with the user by cascade,
 * never logged.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    /** What the browser called itself, for support. Drives no decision. */
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Last send that the push service accepted. Nothing prunes on it yet —
     * a stale row costs one rejected request a day, and deleting a
     * subscription because it has been quiet is how you silently unsubscribe
     * someone who simply had no payments due.
     */
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
  },
  (table) => ({
    endpointUnique: unique('push_subscriptions_endpoint_unique').on(table.endpoint),
    userIdx: index('idx_push_subscriptions_user').on(table.userId),
  })
);

export const pushSubscriptionsRelations = relations(pushSubscriptions, ({ one }) => ({
  user: one(users, {
    fields: [pushSubscriptions.userId],
    references: [users.id],
  }),
}));

export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscription = typeof pushSubscriptions.$inferInsert;
