import { relations } from 'drizzle-orm';
import { index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { tokens } from './tokens';
import { users } from './users';

// One user's own answer to "is this token a scam", which overrides the shared
// `tokens.is_scam_probability` for that user and nobody else (SC-1160).
//
// mgrin, 2026-09-14: a user may flag a token as scam and it must not affect
// other users; every flag is recorded here, and whether a token is marked scam
// GLOBALLY is a human decision taken from these rows — never a threshold
// applied automatically. So nothing reads this table to write `tokens`.
//
// `source` separates a verdict a user gave from one SC-1160's migration
// carried over from the old global write, which recorded no user at all.
// Both columns are CHECK-constrained in the migration.
export const userTokenScamVerdicts = pgTable(
  'user_token_scam_verdicts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenId: uuid('token_id')
      .notNull()
      .references(() => tokens.id, { onDelete: 'cascade' }),
    verdict: text('verdict').$type<'scam' | 'not_scam'>().notNull(),
    source: text('source').$type<'user' | 'migrated'>().notNull().default('user'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    oneVerdictPerUserToken: unique('user_token_scam_verdicts_user_id_token_id_unique').on(
      table.userId,
      table.tokenId
    ),
    tokenIdx: index('idx_user_token_scam_verdicts_token_id').on(table.tokenId),
  })
);

export const userTokenScamVerdictsRelations = relations(userTokenScamVerdicts, ({ one }) => ({
  user: one(users, { fields: [userTokenScamVerdicts.userId], references: [users.id] }),
  token: one(tokens, { fields: [userTokenScamVerdicts.tokenId], references: [tokens.id] }),
}));

export type UserTokenScamVerdict = typeof userTokenScamVerdicts.$inferSelect;
export type NewUserTokenScamVerdict = typeof userTokenScamVerdicts.$inferInsert;
