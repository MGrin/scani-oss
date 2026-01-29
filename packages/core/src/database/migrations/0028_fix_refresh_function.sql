-- Migration: Fix refresh_portfolio_history_views() function for empty materialized views
-- 
-- Issue: REFRESH MATERIALIZED VIEW CONCURRENTLY fails on empty views (created WITH NO DATA)
-- PostgreSQL requires materialized views to be populated before a CONCURRENT refresh can work
-- 
-- Solution: Check if views are empty and use non-concurrent refresh first, then concurrent for subsequent refreshes
--
-- Note: This function should be called from a singleton service (PortfolioHistoryRefreshService) to avoid
-- concurrent execution. Multiple simultaneous calls could cause race conditions or blocking during refresh.

-- Drop the old function
DROP FUNCTION IF EXISTS refresh_portfolio_history_views();

-- Create improved function that handles both empty and populated views
CREATE OR REPLACE FUNCTION refresh_portfolio_history_views() 
RETURNS void AS $$
DECLARE
  v_count INTEGER;
BEGIN
  -- Check if portfolio_history_holding_snapshots is empty
  SELECT COUNT(*) INTO v_count FROM portfolio_history_holding_snapshots;
  
  IF v_count = 0 THEN
    -- First time refresh: Views are empty, use non-concurrent refresh
    RAISE NOTICE 'Portfolio history views are empty, performing initial non-concurrent refresh';
    
    REFRESH MATERIALIZED VIEW portfolio_history_holding_snapshots;
    REFRESH MATERIALIZED VIEW portfolio_history_chart_data;
    REFRESH MATERIALIZED VIEW portfolio_history_events;
    
    RAISE NOTICE 'Initial refresh completed successfully';
  ELSE
    -- Subsequent refreshes: Views have data, use concurrent refresh
    RAISE NOTICE 'Portfolio history views have data, performing concurrent refresh';
    
    REFRESH MATERIALIZED VIEW CONCURRENTLY portfolio_history_holding_snapshots;
    REFRESH MATERIALIZED VIEW CONCURRENTLY portfolio_history_chart_data;
    REFRESH MATERIALIZED VIEW CONCURRENTLY portfolio_history_events;
    
    RAISE NOTICE 'Concurrent refresh completed successfully';
  END IF;
END;
$$ LANGUAGE plpgsql;
