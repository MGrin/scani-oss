-- Index supporting the `hasHoldingCreatedAfter` probe used by
-- ingest-transactions.ts to detect new holdings created after the last
-- portfolio_value_daily snapshot. Without it, the probe falls back to
-- a sequential scan on every tx-import (cron tail, manual import,
-- exchange/wallet sync).
CREATE INDEX IF NOT EXISTS "idx_holdings_user_created_at"
  ON "holdings" ("user_id", "created_at" DESC);
