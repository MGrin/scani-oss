-- Remove the trigger and function that created holding_history records
DROP TRIGGER IF EXISTS holdings_history_trigger ON holdings;--> statement-breakpoint
DROP FUNCTION IF EXISTS track_holding_changes();--> statement-breakpoint

-- Drop the holding_history table
DROP TABLE "holding_history" CASCADE;--> statement-breakpoint

-- Add source column to user_portfolio_events
ALTER TABLE "user_portfolio_events" ADD COLUMN "source" text;