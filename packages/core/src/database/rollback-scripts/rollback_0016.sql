-- Rollback script for 0016_migrate_wallet_data.sql
-- Removes user_wallets entries and restores original account metadata

DO $$
DECLARE
  v_account RECORD;
  v_wallet_address TEXT;
  v_metadata JSONB;
BEGIN
  -- Restore account metadata: remove user_wallet_id and migrated flag
  FOR v_account IN
    SELECT 
      a.id as account_id,
      a.metadata
    FROM accounts a
    WHERE a.metadata->>'migrated' = 'true'
      AND a.metadata->>'user_wallet_id' IS NOT NULL
  LOOP
    -- Remove user_wallet_id and migrated flag from metadata
    v_metadata := v_account.metadata;
    v_metadata := v_metadata - 'user_wallet_id';
    v_metadata := v_metadata - 'migrated';
    
    UPDATE accounts
    SET metadata = v_metadata,
        updated_at = now()
    WHERE id = v_account.account_id;
    
    RAISE NOTICE 'Restored metadata for account %', v_account.account_id;
  END LOOP;

  -- Log count before deletion
  RAISE NOTICE 'Deleting % user_wallets entries', 
    (SELECT COUNT(*) FROM user_wallets);

  -- Delete all user_wallets entries (created by migration)
  -- Note: This will cascade to any related records if foreign keys are set up
  DELETE FROM user_wallets;

  -- Verify deletion
  RAISE NOTICE 'Rollback completed. Remaining user_wallets: %', 
    (SELECT COUNT(*) FROM user_wallets);
    
  RAISE NOTICE 'Rollback completed. Account metadata restored.';
END $$;

-- Verify rollback results
SELECT 
  COUNT(*) as accounts_with_walletAddress,
  'Accounts with walletAddress in metadata' as description
FROM accounts 
WHERE metadata->>'walletAddress' IS NOT NULL
  AND metadata->>'walletAddress' != ''
  AND metadata->>'migrated' IS NULL;

SELECT 
  COUNT(*) as remaining_user_wallets,
  'Remaining user_wallets entries (should be 0)' as description
FROM user_wallets;
