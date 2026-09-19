import { pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { tokens } from './tokens';
import { users } from './users';

// A recurring-payment suggestion the user dismissed (SC-674). Suggestions are
// derived at read time and never stored; only the user's "no" is. Keyed on the
// payee's match key and the currency rather than the amount or the matched
// transactions, so the next sync's new transaction does not bring it back.
export const recurringSuggestionDismissals = pgTable(
  'recurring_suggestion_dismissals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    counterpartyKey: text('counterparty_key').notNull(),
    currencyTokenId: uuid('currency_token_id')
      .notNull()
      .references(() => tokens.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    onePerPayeeCurrency: unique('recurring_suggestion_dismissals_user_payee_currency_unique').on(
      table.userId,
      table.counterpartyKey,
      table.currencyTokenId
    ),
  })
);

export type RecurringSuggestionDismissal = typeof recurringSuggestionDismissals.$inferSelect;
export type NewRecurringSuggestionDismissal = typeof recurringSuggestionDismissals.$inferInsert;
