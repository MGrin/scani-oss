-- Migration script to move legacy Bitcoin wallet account to new system
-- This script:
-- 1. Creates a user_wallet entry for the Bitcoin address
-- 2. Updates the account metadata to include userWalletId and migrated flag

-- Step 1: Create user_wallet entry for Bitcoin wallet
INSERT INTO user_wallets (user_id, wallet_address, institution_ids, label, is_active)
SELECT 
  '27e002bb-04c0-4646-9dae-82b379c9680b',
  '34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo',
  '[\"be2f4f21-4c64-4263-aaee-8e6206001421\"]'::jsonb,
  'main',
  true
WHERE NOT EXISTS (
  SELECT 1 FROM user_wallets 
  WHERE wallet_address = '34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo'
);

-- Step 2: Update Bitcoin account with userWalletId and migrated flag
UPDATE accounts
SET metadata = metadata || jsonb_build_object(
  'userWalletId', (SELECT id FROM user_wallets WHERE wallet_address = '34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo'),
  'migrated', true,
  'chainId', '0',
  'displayName', 'main'
)
WHERE id = '4d522655-cf6a-407d-a46d-bd86007e9e38';

-- Verify migration
SELECT 
  a.id,
  a.name,
  a.metadata->>'migrated' as migrated,
  a.metadata->>'userWalletId' as user_wallet_id,
  uw.wallet_address
FROM accounts a
LEFT JOIN user_wallets uw ON (a.metadata->>'userWalletId')::uuid = uw.id
WHERE a.id = '4d522655-cf6a-407d-a46d-bd86007e9e38';
