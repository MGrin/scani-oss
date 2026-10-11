import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

// A user's own bearer token for their AI agent (SC-1614). Only the SHA-256 of
// the token is stored; the raw value is shown once, when it is created.
export const personalAccessTokens = pgTable(
  'personal_access_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenPrefix: text('token_prefix').notNull(),
    hashedToken: text('hashed_token').notNull().unique(),
    scopes: text('scopes').array().notNull().default(sql`ARRAY['portfolio:read']::text[]`),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userLiveIdx: index('personal_access_tokens_user_live_idx')
      .on(t.userId)
      .where(sql`${t.revokedAt} IS NULL`),
  })
);
