-- Rollback script for 0017_migrate_integration_credentials.sql
-- Removes user_integration_credentials entries created by the migration

DO $$
BEGIN
  -- Log count before deletion
  RAISE NOTICE 'Deleting % user_integration_credentials entries', 
    (SELECT COUNT(*) FROM user_integration_credentials);

  -- Delete all user_integration_credentials entries
  -- Only delete entries with credentials_type = 'api_key' and the marker
  DELETE FROM user_integration_credentials
  WHERE credentials_type = 'api_key'
    AND encrypted_credentials::text LIKE '%useSharedKey%';

  -- Verify deletion
  RAISE NOTICE 'Rollback completed. Remaining credentials with useSharedKey: %', 
    (SELECT COUNT(*) FROM user_integration_credentials 
     WHERE encrypted_credentials::text LIKE '%useSharedKey%');
    
  RAISE NOTICE 'Rollback completed. Integration credentials removed.';
END $$;

-- Verify rollback results
SELECT 
  COUNT(*) as remaining_api_key_credentials,
  'Remaining api_key credentials' as description
FROM user_integration_credentials
WHERE credentials_type = 'api_key';

SELECT 
  COUNT(*) as total_remaining_credentials,
  'Total remaining credentials' as description
FROM user_integration_credentials;
