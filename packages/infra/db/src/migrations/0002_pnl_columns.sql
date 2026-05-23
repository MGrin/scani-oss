-- PnL columns on portfolio_value_daily. Nullable so existing rows
-- (and rollup runs that don't compute PnL) stay valid; the rollup
-- writes them when CostBasisService + PnLAtTimeService are wired up
-- in the same commit.
ALTER TABLE "portfolio_value_daily" ADD COLUMN "cost_basis" text;
--> statement-breakpoint
ALTER TABLE "portfolio_value_daily" ADD COLUMN "realized_pnl" text;
--> statement-breakpoint
ALTER TABLE "portfolio_value_daily" ADD COLUMN "unrealized_pnl" text;
