-- Custom migration: Backfill holding_history for existing holdings
-- This migration creates history entries for holdings that existed before the holding_history table was created
-- Each holding without history will get one record with its current state and last_updated timestamp

INSERT INTO holding_history (
  holding_id,
  user_id,
  account_id,
  token_id,
  balance,
  source,
  timestamp
)
SELECT 
  h.id as holding_id,
  h.user_id,
  h.account_id,
  h.token_id,
  h.balance,
  h.source,
  h.last_updated as timestamp
FROM holdings h
WHERE NOT EXISTS (
  SELECT 1 
  FROM holding_history hh 
  WHERE hh.holding_id = h.id
);
