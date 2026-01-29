-- Migration: Fix refresh_portfolio_history_views() to handle unpopulated views
-- 
-- Issue: The function tries to query materialized views with SELECT COUNT(*)
-- but PostgreSQL does not allow querying materialized views created WITH NO DATA
-- until they are populated with REFRESH MATERIALIZED VIEW.
--
-- Error: "materialized view has not been populated"
--
-- Solution: Check if views are populated using pg_matviews system catalog
-- instead of trying to query the view directly.
--
-- Performance: This refresh is designed to be called asynchronously from the
-- PortfolioHistoryRefreshService. It may take 5-10 minutes to complete on
-- initial population with large datasets (225K+ rows).

-- Drop the old function
DROP FUNCTION IF EXISTS refresh_portfolio_history_views();

-- Create improved function that properly checks if views are populated
CREATE OR REPLACE FUNCTION refresh_portfolio_history_views() 
RETURNS void AS $$
DECLARE
  v_is_populated BOOLEAN;
  v_start_time TIMESTAMP;
  v_duration_ms INTEGER;
BEGIN
  v_start_time := clock_timestamp();
  
  -- Check if portfolio_history_holding_snapshots is populated using system catalog
  -- This avoids the error "materialized view has not been populated"
  SELECT ispopulated INTO v_is_populated 
  FROM pg_matviews 
  WHERE schemaname = 'public' 
    AND matviewname = 'portfolio_history_holding_snapshots';
  
  IF v_is_populated IS NULL THEN
    RAISE EXCEPTION 'Materialized view portfolio_history_holding_snapshots does not exist';
  END IF;
  
  IF v_is_populated = false THEN
    -- First time refresh: Views are not populated, use non-concurrent refresh
    RAISE NOTICE 'Portfolio history views are not populated, performing initial non-concurrent refresh';
    RAISE NOTICE 'This may take 5-10 minutes with large datasets...';
    
    -- Populate views for the first time (non-concurrent)
    -- We refresh them one by one to provide progress feedback
    RAISE NOTICE 'Refreshing portfolio_history_holding_snapshots...';
    REFRESH MATERIALIZED VIEW portfolio_history_holding_snapshots;
    RAISE NOTICE 'Completed portfolio_history_holding_snapshots';
    
    RAISE NOTICE 'Refreshing portfolio_history_chart_data...';
    REFRESH MATERIALIZED VIEW portfolio_history_chart_data;
    RAISE NOTICE 'Completed portfolio_history_chart_data';
    
    RAISE NOTICE 'Refreshing portfolio_history_events...';
    REFRESH MATERIALIZED VIEW portfolio_history_events;
    RAISE NOTICE 'Completed portfolio_history_events';
    
    v_duration_ms := EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time))::INTEGER * 1000;
    RAISE NOTICE 'Initial refresh completed successfully in % ms', v_duration_ms;
  ELSE
    -- Subsequent refreshes: Views are populated, use concurrent refresh
    RAISE NOTICE 'Portfolio history views are populated, performing concurrent refresh';
    
    -- Use CONCURRENTLY to avoid blocking reads during refresh
    REFRESH MATERIALIZED VIEW CONCURRENTLY portfolio_history_holding_snapshots;
    REFRESH MATERIALIZED VIEW CONCURRENTLY portfolio_history_chart_data;
    REFRESH MATERIALIZED VIEW CONCURRENTLY portfolio_history_events;
    
    v_duration_ms := EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time))::INTEGER * 1000;
    RAISE NOTICE 'Concurrent refresh completed successfully in % ms', v_duration_ms;
  END IF;
END;
$$ LANGUAGE plpgsql;
