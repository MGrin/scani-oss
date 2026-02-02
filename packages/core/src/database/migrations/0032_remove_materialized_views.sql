-- Migration: Remove portfolio history materialized views
-- 
-- The materialized views are being removed because:
-- 1. The initial refresh never completes (waited 1.5+ hours)
-- 2. They cause excessive database load on the current instance size
-- 3. The views were created WITH NO DATA and cannot be populated efficiently
--
-- PRESERVED (not dropped):
-- - holding_history table (stores raw history data)
-- - track_holding_changes() function (populates holding_history)
-- - holdings_history_trigger (triggers on holdings changes)
--
-- These preserved items continue to collect historical data that can be
-- used by a future, more efficient implementation.

-- Drop materialized views (CASCADE handles dependencies)
DROP MATERIALIZED VIEW IF EXISTS portfolio_history_events CASCADE;
DROP MATERIALIZED VIEW IF EXISTS portfolio_history_chart_data CASCADE;
DROP MATERIALIZED VIEW IF EXISTS portfolio_history_holding_snapshots CASCADE;

-- Drop the refresh function (no longer needed)
DROP FUNCTION IF EXISTS refresh_portfolio_history_views();
