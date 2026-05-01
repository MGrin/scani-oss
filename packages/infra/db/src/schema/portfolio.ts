import { relations } from 'drizzle-orm';
import {
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { tokens } from './tokens';
import { users } from './users';

// Derived daily rollup cache. Rebuildable from holding_transactions +
// holding_balance_observations + token_prices. Keyed by (user, date,
// base) so switching display currency doesn't invalidate other users'
// caches.
export const portfolioValueDaily = pgTable(
  'portfolio_value_daily',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    snapshotDate: date('snapshot_date').notNull(),
    baseCurrencyId: uuid('base_currency_id')
      .notNull()
      .references(() => tokens.id, { onDelete: 'restrict' }),
    totalValue: text('total_value').notNull(),
    coverageQuality: text('coverage_quality').notNull(),
    holdingsWithKnownValue: integer('holdings_with_known_value').notNull(),
    holdingsTotal: integer('holdings_total').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.userId, table.snapshotDate, table.baseCurrencyId],
    }),
    userDateIdx: index('idx_portfolio_value_daily_user_date').on(
      table.userId,
      table.snapshotDate.desc()
    ),
  })
);

export const portfolioValueDailyRelations = relations(portfolioValueDaily, ({ one }) => ({
  user: one(users, {
    fields: [portfolioValueDaily.userId],
    references: [users.id],
  }),
  baseCurrency: one(tokens, {
    fields: [portfolioValueDaily.baseCurrencyId],
    references: [tokens.id],
  }),
}));

export type PortfolioValueDaily = typeof portfolioValueDaily.$inferSelect;
export type NewPortfolioValueDaily = typeof portfolioValueDaily.$inferInsert;

// Coverage quality bucket on portfolio_value_daily — drives chart
// rendering (solid line / dashed / gap) and informs the data-quality
// panel.
export type CoverageQuality = 'full' | 'partial' | 'estimated' | 'unknown';
