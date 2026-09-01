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
    // ---------------------------------------------------------------------
    // A ZERO IN THE FOUR QUALITY COUNTS BELOW IS NOT ALWAYS A MEASUREMENT.
    //
    // `holdings_unpriceable` (0029), `holdings_stale_priced` (0031),
    // `holdings_basis_unknown` (0031) and `transfers_unreviewed` (0033) were
    // each added `NOT NULL DEFAULT 0`, so every row written before its column
    // existed reads `0` — a positive claim that the day was measured and
    // nothing was wrong, where the truth is that nobody counted. SC-255.
    //
    // `holdings_stale_anchored` further down took the opposite route
    // deliberately (nullable, NULL = not recorded), and the contrast is the
    // point: it can say "unknown" and these four cannot.
    //
    // **This is documented rather than repaired, because no honest cutoff
    // exists.** Measured on production 2026-08-15, read-only:
    //
    ***REMOVED***
    ***REMOVED***
    //   * The first non-zero value in ANY of them appears 2026-08-14 18:07.
    ***REMOVED***
    //   * `drizzle.__drizzle_migrations.created_at` cannot date the boundary:
    //     the timestamps are hand-authored journal values, evenly spaced
    //     10,000s apart, not deploy times.
    //
    // So a backfill would have to invent the cutoff, and would then discard
    // genuine zeros on the recent side of it to remove false ones on the
    // other — two unfounded assertions in place of one. Recomputing instead
    ***REMOVED***
    // under SC-242.
    //
    // What a reader can use instead is a fact already recorded rather than
    // guessed: `holdings_stale_anchored IS NULL` marks every row written
    // before migration 0037, and 0037 is later than 0029/0031/0033 — so a
    // NULL there is sufficient to say the four counts below are of unknown
    // provenance on that row. It is not necessary: a row written after 0037
    // has trustworthy counts, a row before it may or may not.
    // ---------------------------------------------------------------------
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
    // Of `holdings_with_known_value`, how many had their balance
    // extrapolated FORWARD from an observation before this date, because
    // nothing at or after it existed to anchor on. A weaker claim than the
    // other two anchors, and how much weaker depends on how far back —
    // which `oldest_anchor_at` says. Until SC-249 neither number left
    // `BalanceAtTimeService`, so a balance anchored 54 seconds back and one
    // anchored 71 days back reached the chart identically.
    //
    // NULLABLE on purpose, unlike every count above it. NULL means NOT
    // RECORDED — the row predates SC-249 — where `0` means counted and
    // none. `holdings_stale_priced` above took the `NOT NULL DEFAULT 0`
    // route in migration 0031 and so asserts a confident zero for every row
    // written before it existed; that is the failure this column is here to
    // stop making, and repeating it one column to the right would have been
    // absurd.
    holdingsStaleAnchored: integer('holdings_stale_anchored'),
    // The oldest anchor among the backward-anchored holdings — the far end
    // of the weakest reconstruction behind this row's total. NULL when none
    // were backward-anchored OR when the row predates SC-249;
    // `holdings_stale_anchored` tells the two apart (NULL vs 0).
    oldestAnchorAt: timestamp('oldest_anchor_at', { withTimezone: true }),
    // Of `holdings_with_known_value`, how many were valued on a date BEFORE
    // the holding's own first evidence — min(created_at, first tx, first
    // observation) — so the balance is projected backward past anything that
    // records it. SC-252 downgrades those days to 'partial' and until SC-317
    // the row said so with every count at zero: confidence reduced, cause
    // unstated.
    //
    // NOT folded into `holdings_stale_anchored`, which is the near neighbour
    // and the wrong one. That means projected FORWARD from a stale
    // observation; this is projected BACKWARD past first evidence. The
    // remedies differ — sync the source, versus import older history or accept
    // there is none — and collapsing two causes with different remedies into
    // one count is what SC-249 un-collapsed.
    //
    // NULLABLE for the same reason `holdings_stale_anchored` is, and not the
    // `NOT NULL DEFAULT 0` route the four counts above took: NULL means NOT
    // RECORDED, `0` means counted and none. See the block comment above them.
    holdingsBeforeRecords: integer('holdings_before_records'),
    // Of `holdings_with_known_value`, how many had part of their balance
    // INTERPOLATED across a gap between two observations the ledger does not
    // explain (SC-475 fault B). Before that fix the whole unexplained
    // difference landed on the single day the anchor rolled over from one
    // observation to the next — a real account put months of accumulated
    // drift on one day and a chained daily return read it as a double-digit
    // percentage loss on cash.
    //
    // The number on such a row is therefore partly DRAWN rather than
    // measured: a straight line between two observations. Nothing surfaces
    // this yet, and it is recorded anyway — a value nobody can later tell
    // apart from a measured one is a trap for whoever reads it next.
    //
    // Deliberately does NOT feed `coverage_quality`, unlike the counts above
    // it. Interpolating is strictly better than the cliff it replaces, and
    // downgrading every day of every sparsely-observed holding would saturate
    // a bucket that is already saturated.
    //
    // NULLABLE, like the two columns above and unlike the four before them:
    // NULL means NOT RECORDED, 0 means counted and none.
    holdingsInterpolated: integer('holdings_interpolated'),
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
