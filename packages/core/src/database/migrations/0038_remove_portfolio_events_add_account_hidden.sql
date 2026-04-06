-- Drop the user_portfolio_events table (feature removed)
DROP TABLE IF EXISTS "user_portfolio_events" CASCADE;

-- Add isHidden to accounts (synced accounts are hidden instead of deleted)
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "is_hidden" boolean DEFAULT false NOT NULL;
