-- Migration: Add index on plaid_items.is_active for cron job performance
-- This index is critical for the Plaid balances sync cron job which queries:
-- SELECT ... FROM plaid_items WHERE is_active = true
-- Without this index, the query times out after 30 seconds

CREATE INDEX IF NOT EXISTS "idx_plaid_items_is_active" ON "plaid_items" USING btree ("is_active");
