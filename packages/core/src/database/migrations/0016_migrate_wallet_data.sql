-- Custom SQL migration: Populate user_wallets from account metadata
-- This migration extracts wallet addresses from account metadata and creates user_wallets entries

DO $$
DECLARE
  v_crypto_wallet_type_id UUID;
  v_account RECORD;
  v_wallet_address TEXT;
  v_user_id UUID;
  v_institution_id UUID;
  v_institution_ids JSONB;
  v_existing_wallet_id UUID;
  v_wallet_id UUID;
BEGIN
  -- Get the crypto_wallet institution type ID
  SELECT id INTO v_crypto_wallet_type_id 
  FROM institution_types 
  WHERE code = 'crypto_wallet';

  -- Loop through all accounts with wallet addresses in metadata
  FOR v_account IN 
    SELECT 
      a.id as account_id,
      a.user_id,
      a.institution_id,
      a.metadata,
      a.name as account_name
    FROM accounts a
    INNER JOIN institutions i ON a.institution_id = i.id
    WHERE i.type_id = v_crypto_wallet_type_id
      AND a.metadata->>'walletAddress' IS NOT NULL
      AND a.metadata->>'walletAddress' != ''
      AND (a.metadata->>'migrated' IS NULL OR a.metadata->>'migrated' != 'true')
  LOOP
    v_wallet_address := v_account.metadata->>'walletAddress';
    v_user_id := v_account.user_id;
    v_institution_id := v_account.institution_id;

    -- Check if user_wallet already exists for this user and wallet address
    SELECT id, institution_ids 
    INTO v_existing_wallet_id, v_institution_ids
    FROM user_wallets
    WHERE user_id = v_user_id 
      AND wallet_address = v_wallet_address;

    IF v_existing_wallet_id IS NOT NULL THEN
      -- Wallet exists, add institution_id to the array if not already present
      IF NOT (v_institution_ids @> jsonb_build_array(v_institution_id::text)) THEN
        v_institution_ids := v_institution_ids || jsonb_build_array(v_institution_id::text);
        
        UPDATE user_wallets
        SET institution_ids = v_institution_ids,
            updated_at = now()
        WHERE id = v_existing_wallet_id;
      END IF;
      
      v_wallet_id := v_existing_wallet_id;
    ELSE
      -- Create new user_wallet entry
      INSERT INTO user_wallets (
        user_id,
        wallet_address,
        institution_ids,
        label,
        is_active,
        created_at,
        updated_at
      ) VALUES (
        v_user_id,
        v_wallet_address,
        jsonb_build_array(v_institution_id::text),
        v_account.account_name, -- Use account name as label
        true,
        now(),
        now()
      )
      RETURNING id INTO v_wallet_id;
    END IF;

    -- Update account metadata with user_wallet_id and mark as migrated
    UPDATE accounts
    SET metadata = jsonb_set(
          jsonb_set(
            metadata,
            '{user_wallet_id}',
            to_jsonb(v_wallet_id::text)
          ),
          '{migrated}',
          'true'::jsonb
        ),
        updated_at = now()
    WHERE id = v_account.account_id;

    -- Log progress (optional, can be removed if too verbose)
    RAISE NOTICE 'Migrated wallet % for user % (account %)', 
      v_wallet_address, v_user_id, v_account.account_id;
  END LOOP;

  -- Summary
  RAISE NOTICE 'Migration completed. Total user_wallets: %', 
    (SELECT COUNT(*) FROM user_wallets);
END $$;
