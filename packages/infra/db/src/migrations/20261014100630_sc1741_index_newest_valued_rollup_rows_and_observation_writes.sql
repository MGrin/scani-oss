-- 20261014100630 — index newest valued rollup rows and observation writes
-- SC-1741. Returns and gains read a holding's newest VALUED rollup rows, and
-- 74% of holding rows carry no known value (72k of 277k on production,
-- 2026-10-14), so the scope index walked back past hundreds of them per
-- holding. The returns data version counted every balance observation a user
-- has, a whole-table scan for an account that owns 96% of them; it now reads
-- the newest write and review, one index entry each.
--
-- Not CONCURRENTLY: the runner executes each migration inside one transaction,
-- which forbids it. The build holds a SHARE lock, so writes to each table wait
-- while it runs and reads do not: portfolio_value_daily is 66 MB of heap and
-- holding_balance_observations 57 MB, on the order of a second each, as
-- idx_pvd_user_computed_at was (SC-1369). lock_timeout makes a busy table fail
-- the migration rather than queue writes behind it.
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_pvd_valued_holding_newest
  ON portfolio_value_daily (user_id, scope_id, base_currency_id, snapshot_date DESC)
  WHERE scope_kind = 'holding' AND holdings_with_known_value > 0;

CREATE INDEX IF NOT EXISTS idx_holding_obs_user_created
  ON holding_balance_observations (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_holding_obs_user_gap_reviewed
  ON holding_balance_observations (user_id, gap_reviewed_at DESC NULLS LAST)
  WHERE gap_reviewed_at IS NOT NULL;
