-- Partial index for the data-quality / zero-balance filters that
-- previously seq-scanned the `holdings` table.
--
-- The data-quality report (`portfolio.getDataQualityReport`) and a
-- handful of background sweepers count or filter holdings where
-- `balance::numeric = 0` AND `is_hidden = false`. Without this index
-- those queries seq-scan; for users with thousands of holdings the
-- per-call latency is several hundred ms.
--
-- A partial index keyed on `user_id` filtered by the same predicate
-- keeps the index tiny — it only contains rows that actually match
-- the filter — while still being usable by the planner. Visible
-- non-zero rows are excluded from the index entirely.
--
-- Drizzle's migrator wraps each migration in BEGIN/COMMIT.
-- CREATE INDEX CONCURRENTLY can't run inside a transaction (Postgres
-- error 25001), so we use the plain non-concurrent form. `IF NOT
-- EXISTS` keeps the migration idempotent if it's partially re-run.
-- Our holdings table is small enough that the brief ACCESS EXCLUSIVE
-- lock during creation is acceptable. Same pattern as
-- 0009_user_sessions_user_id_idx.sql.

CREATE INDEX IF NOT EXISTS idx_holdings_user_visible_zero_balance
  ON holdings (user_id)
  WHERE balance::numeric = 0 AND is_hidden = false;

-- Mirror partial index for the inverse "visible AND non-zero" filter
-- used by the unpriced-visible sub-report. Same rationale.
CREATE INDEX IF NOT EXISTS idx_holdings_user_visible_nonzero_balance
  ON holdings (user_id)
  WHERE balance::numeric > 0 AND is_hidden = false;
