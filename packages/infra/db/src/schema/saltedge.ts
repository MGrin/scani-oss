import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * The Salt Edge customer made for a user (SC-1244). A signed callback names
 * only `customer_id`, so this is how it is traced back to a user; the same id
 * also sits in the user's encrypted credential row, where the provider reads it.
 */
export const saltedgeCustomers = pgTable('saltedge_customers', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  customerId: text('customer_id').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One linked bank login, kept current from Salt Edge's callbacks. */
export const saltedgeConnections = pgTable(
  'saltedge_connections',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    customerId: text('customer_id').notNull(),
    connectionId: text('connection_id').notNull().unique(),
    /** `active`, `failed` or `inactive` (consent expired or revoked). */
    status: text('status').notNull(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index('idx_saltedge_connections_user_id').on(table.userId),
  })
);

export type SaltedgeConnection = typeof saltedgeConnections.$inferSelect;
