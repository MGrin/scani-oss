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
// holding_balance_observations + token_prices. Keyed by
// (user, scope_kind, scope_id, date, base) so the same table holds
// user-wide rollups *and* per-institution / per-account / per-holding
// scoped series for the detail-page charts. `scope_id` is the
// user_id for scope='user' (sentinel — Postgres composite PKs treat
// NULL as not-equal-to-NULL, so a non-null sentinel keeps the unique
// constraint usable).
export const portfolioValueDaily = pgTable(
  'portfolio_value_daily',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scopeKind: text('scope_kind').notNull().default('user'),
    scopeId: uuid('scope_id').notNull(),
    snapshotDate: date('snapshot_date').notNull(),
    baseCurrencyId: uuid('base_currency_id')
      .notNull()
      .references(() => tokens.id, { onDelete: 'restrict' }),
    totalValue: text('total_value').notNull(),
    coverageQuality: text('coverage_quality').notNull(),
    holdingsWithKnownValue: integer('holdings_with_known_value').notNull(),
    holdingsTotal: integer('holdings_total').notNull(),
    // PnL columns: nullable until the rollup runs (back-compat with
    // pre-C3 rows). cost_basis is the sum of remaining open lots'
    // cost in the row's base currency (FX-converted at purchase
    // time). realized_pnl is cumulative gain/loss from closed
    // positions up to snapshot_date. unrealized_pnl =
    // total_value - cost_basis. All decimal strings.
    costBasis: text('cost_basis'),
    realizedPnl: text('realized_pnl'),
    unrealizedPnl: text('unrealized_pnl'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [
        table.userId,
        table.scopeKind,
        table.scopeId,
        table.snapshotDate,
        table.baseCurrencyId,
      ],
    }),
    userDateIdx: index('idx_portfolio_value_daily_user_date').on(
      table.userId,
      table.snapshotDate.desc()
    ),
    scopeUserDateIdx: index('idx_pvd_scope_user_date').on(
      table.userId,
      table.scopeKind,
      table.scopeId,
      table.snapshotDate.desc()
    ),
  })
);

// Scope kind for portfolio_value_daily.scope_kind. 'user' rows are
// the user-wide totals (scope_id = userId sentinel). The per-entity
// rows enable detail-page charts without requiring three more tables.
export type PortfolioValueScopeKind = 'user' | 'institution' | 'account' | 'holding';

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
