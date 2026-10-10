import { jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * The last eligible answer `portfolio.getReturns` gave, per scope and window
 * (SC-1694). While a history rebuild runs the live answer is withheld as
 * `rebuilding-history`, and this is what the card shows instead, "as of"
 * `computed_at`. Derived and replaceable: it is never a source of truth.
 */
export const returnsLastComplete = pgTable(
  'returns_last_complete',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scopeKey: text('scope_key').notNull(),
    windowKey: text('window_key').notNull(),
    baseCurrencyId: text('base_currency_id').notNull(),
    // The response exactly as it went out: `{ returns, benchmarks }`.
    answer: jsonb('answer').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.scopeKey, table.windowKey] }),
  })
);

export type ReturnsLastComplete = typeof returnsLastComplete.$inferSelect;
export type NewReturnsLastComplete = typeof returnsLastComplete.$inferInsert;
