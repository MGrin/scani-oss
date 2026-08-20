import { relations, sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Standing sentences about a counterparty address, evaluated when the
 * transfer-review queue is read (SC-375).
 *
 * A rule says one of two things and neither of them is an answer: either
 * "stop asking me about this address" (`not_a_disposal`) or "keep asking, but
 * tell me it is this" (`ask_me`). Nothing here writes `transfer_review`, so no
 * rule moves a number — an outflow with no review realizes nothing, because
 * `isConfirmedDisposal` is `left_control` alone. That is why a rule can be
 * applied unattended and retroactively at once, and why revoking one is a
 * complete undo: the rows it was hiding were never modified.
 *
 * `match_counterparty` holds a normalized counterparty IDENTITY, not a raw
 * string and — despite what SC-375's name for it said — not necessarily an
 * address. Every populated `counterparty` in production is free text a payment
 * rail rendered, and it leads with the amount, so a rule keyed on the whole
 * description matched one payment and never the next one to the same person
 * (SC-381). Both sides of the comparison are put through the one
 * `transfer_counterparty_key` SQL function: trimmed, lowercased, and stripped
 * of a `Pay <amount> <CCY> to ` preamble. EVM addresses travel in EIP-55 mixed
 * case, the two sides come from different places, and no address begins with
 * `Pay `.
 *
 * **The key is a field an attacker can write to.** Address poisoning sprays
 * zero-value transfers to plant a lookalike address in a victim's history, and
 ***REMOVED***
 * contain that here and both are structural rather than careful: no verdict in
 * this table can assert a disposal, and `match_counterparty` is never typed — it is
 * copied out of a transaction the user owns, by the service, which is why
 * there is no free-text address input anywhere in the write path.
 */
export const transferReviewRules = pgTable(
  'transfer_review_rules',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // The output of `transfer_counterparty_key`. Matching is exact equality on
    // this column: never a prefix, never an `ilike`, and never the truncated
    // form the UI renders — two addresses sharing twelve displayed characters
    // are cheap to generate. What SC-381 changed is what both sides are
    // normalized TO, which keeps the comparison exact while letting one rule
    // cover every payment to a recipient.
    matchCounterparty: text('match_counterparty').notNull(),
    verdict: text('verdict').notNull(),
    ***REMOVED***
    // is not, and the queue's whole problem is that the reader cannot
    // recognise an address. Required, not decoration.
    note: text('note').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Revoked rather than deleted: a rule that hid rows for a month is history,
    // and the rows it hid are answerable again the moment it is set.
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => ({
    activeCounterpartyUq: uniqueIndex('transfer_review_rules_active_counterparty_uq')
      .on(table.userId, table.matchCounterparty)
      .where(sql`revoked_at IS NULL`),
    userActiveIdx: index('idx_transfer_review_rules_user_active')
      .on(table.userId)
      .where(sql`revoked_at IS NULL`),
  })
);

export const transferReviewRulesRelations = relations(transferReviewRules, ({ one }) => ({
  user: one(users, {
    fields: [transferReviewRules.userId],
    references: [users.id],
  }),
}));

export type TransferReviewRule = typeof transferReviewRules.$inferSelect;
export type NewTransferReviewRule = typeof transferReviewRules.$inferInsert;
