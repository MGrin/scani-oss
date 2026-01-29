-- Migration: Create materialized views for portfolio history optimization
-- This migration creates materialized views to pre-compute portfolio history data
-- and avoid expensive in-memory joins and calculations in the application

-- ============================================================================
-- 1. Materialized View: Latest holding state for each holding at each timestamp
-- ============================================================================
-- This view pre-computes the most recent holding balance for each holding at each timestamp
-- Eliminates the need to scan all holding history records repeatedly in application code

CREATE MATERIALIZED VIEW IF NOT EXISTS portfolio_history_holding_snapshots
WITH NO DATA
AS
SELECT DISTINCT ON (hh.user_id, hh.holding_id, hh.timestamp)
  hh.id,
  hh.holding_id,
  hh.user_id,
  hh.account_id,
  hh.token_id,
  hh.balance,
  hh.source,
  hh.timestamp,
  t.symbol AS token_symbol,
  t.name AS token_name
FROM holding_history hh
JOIN tokens t ON t.id = hh.token_id
WHERE t.is_active = true
ORDER BY hh.user_id, hh.holding_id, hh.timestamp DESC;

-- Create unique index required for CONCURRENT refresh
CREATE UNIQUE INDEX IF NOT EXISTS idx_portfolio_snapshots_unique 
  ON portfolio_history_holding_snapshots (user_id, holding_id, timestamp);

-- Create additional indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_user_timestamp 
  ON portfolio_history_holding_snapshots (user_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_token 
  ON portfolio_history_holding_snapshots (token_id, timestamp DESC);

-- ============================================================================
-- 2. Materialized View: Portfolio value at each unique timestamp
-- ============================================================================
-- This view pre-computes total portfolio value at each timestamp
-- Eliminates expensive in-memory aggregations for chart data

CREATE MATERIALIZED VIEW IF NOT EXISTS portfolio_history_chart_data
WITH NO DATA
AS
WITH unique_user_timestamps AS (
  -- Get all unique (user_id, timestamp) combinations where portfolio changed
  SELECT DISTINCT user_id, timestamp
  FROM holding_history
),
latest_holdings_at_timestamp AS (
  -- For each (user, timestamp), get the latest holding state for each holding
  -- Using window function for better performance than nested queries
  SELECT 
    user_id,
    timestamp,
    holding_id,
    token_id,
    balance,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, timestamp, holding_id 
      ORDER BY hh_timestamp DESC
    ) AS rn
  FROM unique_user_timestamps ut
  CROSS JOIN LATERAL (
    SELECT 
      holding_id,
      token_id,
      balance,
      timestamp AS hh_timestamp
    FROM holding_history
    WHERE user_id = ut.user_id 
      AND timestamp <= ut.timestamp
  ) hh
),
holdings_with_prices AS (
  -- Join with latest prices for each token using lateral join for performance
  SELECT 
    lh.user_id,
    lh.timestamp,
    lh.holding_id,
    lh.token_id,
    lh.balance,
    COALESCE(tp.price, '0') AS price,
    u.base_currency_id
  FROM latest_holdings_at_timestamp lh
  JOIN users u ON u.id = lh.user_id
  LEFT JOIN LATERAL (
    SELECT price
    FROM token_prices
    WHERE token_id = lh.token_id 
      AND base_token_id = u.base_currency_id
      AND timestamp <= lh.timestamp
    ORDER BY timestamp DESC
    LIMIT 1
  ) tp ON true
  WHERE lh.rn = 1  -- Only keep the latest holding state
)
SELECT 
  user_id,
  timestamp,
  base_currency_id,
  COUNT(DISTINCT holding_id) AS holdings_count,
  SUM(CAST(balance AS DECIMAL) * CAST(price AS DECIMAL))::TEXT AS total_value
FROM holdings_with_prices
GROUP BY user_id, timestamp, base_currency_id;

-- Create unique index required for CONCURRENT refresh
CREATE UNIQUE INDEX IF NOT EXISTS idx_portfolio_chart_unique 
  ON portfolio_history_chart_data (user_id, timestamp);

-- Create additional indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_portfolio_chart_timestamp 
  ON portfolio_history_chart_data (timestamp DESC);

-- ============================================================================
-- 3. Materialized View: Portfolio events (holding updates + price updates)
-- ============================================================================
-- This view combines holding updates and price updates into a single timeline
-- Eliminates the need to merge and sort events in application memory

CREATE MATERIALIZED VIEW IF NOT EXISTS portfolio_history_events
WITH NO DATA
AS
-- Holding update events
SELECT 
  hh.id,
  hh.user_id,
  hh.timestamp,
  'holding_update' AS event_type,
  hh.holding_id,
  hh.token_id,
  t.symbol AS token_symbol,
  t.name AS token_name,
  hh.balance,
  COALESCE(tp.price, '0') AS price,
  (CAST(hh.balance AS DECIMAL) * CAST(COALESCE(tp.price, '0') AS DECIMAL))::TEXT AS value,
  bt.symbol AS base_currency_symbol
FROM holding_history hh
JOIN tokens t ON t.id = hh.token_id
JOIN users u ON u.id = hh.user_id
LEFT JOIN LATERAL (
  SELECT price
  FROM token_prices
  WHERE token_id = hh.token_id 
    AND base_token_id = u.base_currency_id
    AND timestamp <= hh.timestamp
  ORDER BY timestamp DESC
  LIMIT 1
) tp ON true
LEFT JOIN tokens bt ON bt.id = u.base_currency_id

UNION ALL

-- Price update events (only for tokens that users actually hold)
-- First identify user-token pairs that exist in holding history
SELECT 
  gen_random_uuid() AS id,
  user_token.user_id,
  tp.timestamp,
  'price_update' AS event_type,
  NULL AS holding_id,
  tp.token_id,
  t.symbol AS token_symbol,
  t.name AS token_name,
  hh_latest.balance,
  tp.price,
  (CAST(hh_latest.balance AS DECIMAL) * CAST(tp.price AS DECIMAL))::TEXT AS value,
  bt.symbol AS base_currency_symbol
FROM (
  -- Get unique (user_id, token_id) pairs from holding history
  SELECT DISTINCT user_id, token_id
  FROM holding_history
) user_token
JOIN token_prices tp ON tp.token_id = user_token.token_id
JOIN tokens t ON t.id = tp.token_id
JOIN users u ON u.id = user_token.user_id AND tp.base_token_id = u.base_currency_id
-- Get the most recent holding balance before this price update
LEFT JOIN LATERAL (
  SELECT balance
  FROM holding_history
  WHERE user_id = user_token.user_id 
    AND token_id = user_token.token_id
    AND timestamp <= tp.timestamp
  ORDER BY timestamp DESC
  LIMIT 1
) hh_latest ON true
LEFT JOIN tokens bt ON bt.id = u.base_currency_id
WHERE hh_latest.balance IS NOT NULL
  -- Exclude if there's a holding update at the exact same timestamp
  AND NOT EXISTS (
    SELECT 1 
    FROM holding_history hh
    WHERE hh.user_id = user_token.user_id 
      AND hh.token_id = user_token.token_id
      AND hh.timestamp = tp.timestamp
  );

-- Create unique index required for CONCURRENT refresh
-- Since we have UNION ALL with potential duplicates, we use id as unique identifier
CREATE UNIQUE INDEX IF NOT EXISTS idx_portfolio_events_unique 
  ON portfolio_history_events (id);

-- Create additional indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_portfolio_events_user_timestamp 
  ON portfolio_history_events (user_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_portfolio_events_user_type_timestamp 
  ON portfolio_history_events (user_id, event_type, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_portfolio_events_token 
  ON portfolio_history_events (token_id, timestamp DESC);

-- ============================================================================
-- 4. Function to refresh all portfolio history materialized views
-- ============================================================================
-- This function provides a convenient way to refresh all views at once
-- Uses CONCURRENTLY to avoid blocking reads during refresh

CREATE OR REPLACE FUNCTION refresh_portfolio_history_views() 
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY portfolio_history_holding_snapshots;
  REFRESH MATERIALIZED VIEW CONCURRENTLY portfolio_history_chart_data;
  REFRESH MATERIALIZED VIEW CONCURRENTLY portfolio_history_events;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 5. Initial population of materialized views
-- ============================================================================

-- NOTE: Views are created WITH NO DATA to prevent migration timeout on Render
-- 
-- PostgreSQL's CREATE MATERIALIZED VIEW immediately populates the view by default,
-- which causes timeouts when processing large datasets (225K+ rows) with complex
-- joins and aggregations. The WITH NO DATA clause creates the view structure only,
-- making the migration complete in seconds instead of minutes.
--
-- The materialized views will be empty after migration and will be populated
-- on first application startup by the PortfolioHistoryRefreshService.
-- This service runs automatically on backend initialization and refreshes views
-- every 10 minutes thereafter.
--
-- The views are created with unique indexes to support CONCURRENT refresh,
-- which allows the refresh to happen without blocking reads from the views.
--
-- If you need to manually populate the views before the first refresh cycle,
-- you can run: SELECT refresh_portfolio_history_views();
-- This will take several minutes to complete depending on data volume.
