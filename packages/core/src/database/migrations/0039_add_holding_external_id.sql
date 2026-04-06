-- Add external_id column to holdings for unique identification of synced holdings.
-- Multiple holdings of the same token in the same account are intentionally allowed
-- (e.g., USD in checking vs savings, or same asset from different sync sources).
-- For synced holdings, external_id stores the exchange's asset identifier (e.g., 'BTC' for Binance).
-- For manually created holdings, external_id is NULL.
ALTER TABLE "holdings" ADD COLUMN "external_id" text;

-- Index for efficient lookup during sync: (account_id, token_id, external_id)
CREATE INDEX "idx_holdings_account_token_external" ON "holdings" ("account_id", "token_id", "external_id");
