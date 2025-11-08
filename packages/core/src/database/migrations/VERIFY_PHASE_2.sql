-- Verification Queries for Phase 2 Migration
-- Run these queries before and after migration to verify the migration was successful

-- ============================================================================
-- PRE-MIGRATION VERIFICATION
-- ============================================================================

-- 1. Count accounts with wallet addresses (before migration)
SELECT 
  COUNT(*) as total_accounts_with_wallets,
  'Accounts with walletAddress in metadata' as description
FROM accounts 
WHERE metadata->>'walletAddress' IS NOT NULL 
  AND metadata->>'walletAddress' != '';

-- 2. Count unique wallet addresses per user
SELECT 
  COUNT(DISTINCT (user_id, metadata->>'walletAddress')) as unique_user_wallet_combinations,
  'Expected user_wallets entries after migration' as description
FROM accounts 
WHERE metadata->>'walletAddress' IS NOT NULL
  AND metadata->>'walletAddress' != '';

-- 3. Count blockchain institutions (should get has_integration = true)
SELECT 
  COUNT(*) as blockchain_institutions,
  'Institutions that should get has_integration = true' as description
FROM institutions i
INNER JOIN institution_types it ON i.type_id = it.id
WHERE it.code = 'crypto_wallet';

-- 4. Count users with blockchain accounts
SELECT 
  COUNT(DISTINCT a.user_id) as users_with_blockchain_accounts,
  'Users who should get integration credentials' as description
FROM accounts a
INNER JOIN institutions i ON a.institution_id = i.id
INNER JOIN institution_types it ON i.type_id = it.id
WHERE it.code = 'crypto_wallet'
  AND a.metadata->>'walletAddress' IS NOT NULL
  AND a.metadata->>'walletAddress' != '';

-- ============================================================================
-- POST-MIGRATION VERIFICATION
-- ============================================================================

-- 5. Verify user_wallets entries were created
SELECT 
  COUNT(*) as user_wallets_created,
  'user_wallets entries (should match query #2)' as description
FROM user_wallets;

-- 6. Verify institution_ids are populated
SELECT 
  COUNT(*) as wallets_with_institution_ids,
  'user_wallets with non-empty institution_ids' as description
FROM user_wallets 
WHERE jsonb_array_length(institution_ids) > 0;

-- 7. Verify integration credentials were created
SELECT 
  COUNT(*) as credentials_created,
  'user_integration_credentials entries' as description
FROM user_integration_credentials 
WHERE credentials_type = 'api_key';

-- 8. Verify blockchain institutions marked with integration
SELECT 
  COUNT(*) as institutions_with_integration,
  'Blockchain institutions with has_integration = true' as description
FROM institutions i
INNER JOIN institution_types it ON i.type_id = it.id
WHERE it.code = 'crypto_wallet'
  AND i.has_integration = true;

-- 9. Verify account metadata was updated
SELECT 
  COUNT(*) as migrated_accounts,
  'Accounts marked as migrated' as description
FROM accounts 
WHERE metadata->>'migrated' = 'true';

-- 10. Verify account metadata has user_wallet_id
SELECT 
  COUNT(*) as accounts_with_wallet_id,
  'Accounts with user_wallet_id in metadata' as description
FROM accounts 
WHERE metadata->>'user_wallet_id' IS NOT NULL;

-- 11. Verify original walletAddress preserved
SELECT 
  COUNT(*) as accounts_with_original_address,
  'Accounts with original walletAddress preserved' as description
FROM accounts 
WHERE metadata->>'walletAddress' IS NOT NULL
  AND metadata->>'migrated' = 'true';

-- ============================================================================
-- DETAILED VERIFICATION
-- ============================================================================

-- 12. Sample user_wallets entries
SELECT 
  uw.id,
  uw.user_id,
  uw.wallet_address,
  jsonb_array_length(uw.institution_ids) as num_chains,
  uw.label,
  uw.is_active
FROM user_wallets uw
LIMIT 10;

-- 13. Sample integration credentials
SELECT 
  uic.id,
  uic.user_id,
  i.name as institution_name,
  uic.credentials_type,
  uic.encrypted_credentials,
  uic.is_active
FROM user_integration_credentials uic
INNER JOIN institutions i ON uic.institution_id = i.id
LIMIT 10;

-- 14. Verify institution_ids array content
SELECT 
  uw.wallet_address,
  jsonb_array_length(uw.institution_ids) as num_chains,
  uw.institution_ids
FROM user_wallets uw
LIMIT 5;

-- 15. Check for any accounts that failed to migrate
SELECT 
  a.id,
  a.name,
  a.metadata->>'walletAddress' as wallet_address,
  a.metadata->>'migrated' as migrated,
  a.metadata->>'user_wallet_id' as user_wallet_id
FROM accounts a
INNER JOIN institutions i ON a.institution_id = i.id
INNER JOIN institution_types it ON i.type_id = it.id
WHERE it.code = 'crypto_wallet'
  AND a.metadata->>'walletAddress' IS NOT NULL
  AND a.metadata->>'walletAddress' != ''
  AND (a.metadata->>'migrated' IS NULL OR a.metadata->>'migrated' != 'true')
LIMIT 10;

-- ============================================================================
-- DATA INTEGRITY CHECKS
-- ============================================================================

-- 16. Verify user_wallet_id references are valid
SELECT 
  COUNT(*) as invalid_references,
  'Accounts with invalid user_wallet_id (should be 0)' as description
FROM accounts a
WHERE a.metadata->>'user_wallet_id' IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM user_wallets uw 
    WHERE uw.id::text = a.metadata->>'user_wallet_id'
  );

-- 17. Verify no duplicate user+wallet combinations
SELECT 
  user_id,
  wallet_address,
  COUNT(*) as count,
  'Duplicate entries (should be 0 rows)' as description
FROM user_wallets
GROUP BY user_id, wallet_address
HAVING COUNT(*) > 1;

-- 18. Verify credentials match users with wallets
SELECT 
  (SELECT COUNT(DISTINCT user_id) FROM user_wallets) as users_with_wallets,
  (SELECT COUNT(DISTINCT user_id) FROM user_integration_credentials 
   WHERE credentials_type = 'api_key') as users_with_credentials,
  'Both counts should be equal or close' as description;

-- ============================================================================
-- ROLLBACK VERIFICATION (run after rollback)
-- ============================================================================

-- 19. Verify user_wallets table is empty (after rollback)
SELECT 
  COUNT(*) as remaining_wallets,
  'Should be 0 after rollback' as description
FROM user_wallets;

-- 20. Verify account metadata restored (after rollback)
SELECT 
  COUNT(*) as accounts_with_migration_flag,
  'Should be 0 after rollback' as description
FROM accounts 
WHERE metadata->>'migrated' IS NOT NULL;

-- 21. Verify credentials removed (after rollback)
SELECT 
  COUNT(*) as remaining_api_key_credentials,
  'Should be 0 after rollback' as description
FROM user_integration_credentials
WHERE credentials_type = 'api_key'
  AND encrypted_credentials::text LIKE '%useSharedKey%';

-- 22. Verify hasIntegration reverted (after rollback)
SELECT 
  COUNT(*) as institutions_with_integration,
  'Should be 0 after rollback' as description
FROM institutions 
WHERE has_integration = true
  AND id IN (
    '45ab1358-a63c-4b5b-a305-082fa208ee0f',
    '71e709cf-f8db-48a3-877a-e19dadeeb6aa',
    '8a91aba5-b7d3-4d08-99f9-d075a3c8ebc6',
    'f20ba475-99e7-4c7c-814d-cfb719b8dc4a'
  );
