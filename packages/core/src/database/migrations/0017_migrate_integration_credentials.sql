-- Custom SQL migration: Populate user_integration_credentials for blockchain users
-- This creates credential entries for users who have blockchain wallets
-- NOTE: The encrypted_credentials contain a marker {"useSharedKey": true, "encrypted": false}
--       In production, these should be properly encrypted using the IntegrationCredentialsService

DO $$
DECLARE
  v_institution RECORD;
  v_user_id UUID;
  v_credential_marker JSONB;
BEGIN
  -- Marker for credentials that use shared API key
  v_credential_marker := '{"useSharedKey": true, "encrypted": false}'::jsonb;

  -- Loop through all blockchain institutions with hasIntegration = true
  FOR v_institution IN
    SELECT DISTINCT i.id as institution_id, i.name as institution_name
    FROM institutions i
    INNER JOIN institution_types it ON i.type_id = it.id
    WHERE it.code = 'crypto_wallet'
      AND i.has_integration = true
  LOOP
    -- For each institution, find users who have wallets/accounts on that chain
    FOR v_user_id IN
      SELECT DISTINCT a.user_id
      FROM accounts a
      WHERE a.institution_id = v_institution.institution_id
        AND a.metadata->>'walletAddress' IS NOT NULL
        AND a.metadata->>'walletAddress' != ''
    LOOP
      -- Insert or update credential entry for this user+institution combination
      INSERT INTO user_integration_credentials (
        user_id,
        institution_id,
        encrypted_credentials,
        credentials_type,
        is_active,
        created_at,
        updated_at
      ) VALUES (
        v_user_id,
        v_institution.institution_id,
        v_credential_marker,
        'api_key',
        true,
        now(),
        now()
      )
      ON CONFLICT (user_id, institution_id) 
      DO UPDATE SET
        encrypted_credentials = EXCLUDED.encrypted_credentials,
        credentials_type = EXCLUDED.credentials_type,
        is_active = EXCLUDED.is_active,
        updated_at = now();

      RAISE NOTICE 'Created/Updated credentials for user % on institution % (%)', 
        v_user_id, v_institution.institution_name, v_institution.institution_id;
    END LOOP;
  END LOOP;

  -- Summary
  RAISE NOTICE 'Migration completed. Total credentials: %', 
    (SELECT COUNT(*) FROM user_integration_credentials);
    
  RAISE WARNING 'IMPORTANT: Credentials contain unencrypted marker {"useSharedKey": true, "encrypted": false}. These should be properly encrypted using IntegrationCredentialsService before use in production.';
END $$;
