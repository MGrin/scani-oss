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
    // Of `holdings_total`, how many no provider can price *in fact* —
    // never had a single price row and currently inside an unpriceable
    // cooldown. `holdings_total` keeps its original meaning (every
    // holding in scope) so old rows are not retroactively reinterpreted;
    // coverage is `holdings_with_known_value / (holdings_total -
    // holdings_unpriceable)`. See SC-146.
    holdingsUnpriceable: integer('holdings_unpriceable').notNull().default(0),
    // Of `holdings_with_known_value`, how many were valued from a price
    // older than the freshness window. They stay in `total_value` — an old
    // price is still the best measurement of what something is worth, and
    // dropping it would open a hole in the chart on a pure data-gap day —
    // but the count travels with the figure so no surface presents it as a
    // quote from the day it is plotted on. See SC-151.
    holdingsStalePriced: integer('holdings_stale_priced').notNull().default(0),
    // Of `holdings_total`, how many carry a cost basis we do not know:
    // no cost-relevant transaction, a provider that reported its history
    // truncated, a leg priced beyond the staleness cap, or an inflow
    // booked at zero cost for want of any price reference. The cost
    // columns below still include them — pulling a holding's cost while
    // its value stays would move the whole value into unrealized gain,
    // which is the error this exists to expose, not to commit. See SC-149.
    holdingsBasisUnknown: integer('holdings_basis_unknown').notNull().default(0),
    // Outflows on or before this date whose lots left with no gain booked,
    // because SC-150 realizes only a person's `left_control` answer. A count
    // of TRANSACTIONS, not of holdings — the review queue lists transactions
    // and is answered one at a time — and only of rows that queue actually
    // holds, so the number and the page it points at agree. The one count on
    // this table whose error runs downward: `realized_pnl` is short by
    // whatever the genuine disposals among them were worth. See SC-160.
    transfersUnreviewed: integer('transfers_unreviewed').notNull().default(0),
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
