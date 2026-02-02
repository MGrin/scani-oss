-- Migration: Deduplicate holdings and add unique constraint
--
-- Problem: A bug in SyncWalletBalancesUseCase was creating duplicate holdings
-- for tokens with high scam probability because the findByAccount method
-- filtered out scam tokens, causing the sync to think no holding existed.
--
-- This migration:
-- 1. Identifies duplicate holdings (same account_id + token_id)
-- 2. Keeps only the most recently updated holding for each combination
-- 3. Adds a unique constraint to prevent future duplicates
-- 4. Fixes native tokens (like MATIC) that shouldn't be marked as scam

-- Step 1: Delete duplicate holdings, keeping the most recently updated one
-- This uses a CTE to identify which holdings to keep
WITH duplicates AS (
  SELECT 
    h.id,
    h.account_id,
    h.token_id,
    h.last_updated,
    ROW_NUMBER() OVER (
      PARTITION BY h.account_id, h.token_id 
      ORDER BY h.last_updated DESC NULLS LAST, h.created_at DESC
    ) as rn
  FROM holdings h
),
holdings_to_delete AS (
  SELECT id 
  FROM duplicates 
  WHERE rn > 1
)
DELETE FROM holdings 
WHERE id IN (SELECT id FROM holdings_to_delete);
--> statement-breakpoint

-- Step 2: Add unique constraint on (account_id, token_id)
-- This prevents duplicate holdings from being created in the future
ALTER TABLE holdings 
ADD CONSTRAINT holdings_account_token_unique 
UNIQUE (account_id, token_id);
--> statement-breakpoint

-- Step 3: Fix native tokens that are incorrectly marked as scam
-- Native tokens for major chains should not have high scam probability
UPDATE tokens
SET is_scam_probability = 0
WHERE provider_metadata::text LIKE '%"isNative":true%'
  AND is_scam_probability > 0.45;
--> statement-breakpoint

-- Step 4: Also clean up holding_history to remove entries for deleted holdings
-- This is handled automatically by ON DELETE CASCADE constraint
