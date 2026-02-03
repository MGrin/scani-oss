-- Migration: Fix scam token filtering bug in holdings sync
--
-- Problem: A bug in SyncWalletBalancesUseCase was creating duplicate holdings
-- for tokens with high scam probability because the findByAccount method
-- filtered out scam tokens, causing the sync to think no holding existed.
--
-- The code fix has been applied (includeScamTokens parameter).
-- This migration fixes native tokens that shouldn't be marked as scam.
--
-- NOTE: Multiple holdings per (account_id, token_id) are INTENTIONALLY ALLOWED
-- because users may want to track separate holdings (e.g., USD checking vs savings).

-- Fix native tokens that are incorrectly marked as scam
-- Native tokens for major chains should not have high scam probability
UPDATE tokens
SET is_scam_probability = 0
WHERE provider_metadata::text LIKE '%"isNative":true%'
  AND is_scam_probability > 0.45;
--> statement-breakpoint

-- Step 4: Also clean up holding_history to remove entries for deleted holdings
-- This is handled automatically by ON DELETE CASCADE constraint
