import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

// A user's subscribable bills calendar (SC-1654). One row means the feed is on;
// only the SHA-256 of its token is stored. Rotating replaces the hash and
// turning it off deletes the row, so either kills the old URL at once.
export const billCalendarFeeds = pgTable('bill_calendar_feeds', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  hashedToken: text('hashed_token').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
