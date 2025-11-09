-- Custom SQL migration: Add TON blockchain institution and mapping
-- TON is supported by the system but was missing from the institutions table

DO $$
DECLARE
  v_crypto_wallet_type_id uuid;
  v_ton_institution_id uuid;
BEGIN
  -- Get crypto_wallet type ID
  SELECT id INTO v_crypto_wallet_type_id FROM institution_types WHERE code = 'crypto_wallet';

  -- Insert TON institution if it doesn't exist
  INSERT INTO institutions (name, type_id, description, website, is_active)
  VALUES ('TON', v_crypto_wallet_type_id, 'The Open Network - Layer-1 blockchain designed for mass adoption', 'https://ton.org', true)
  ON CONFLICT (website) DO NOTHING
  RETURNING id INTO v_ton_institution_id;

  -- If institution already existed, get its ID
  IF v_ton_institution_id IS NULL THEN
    SELECT id INTO v_ton_institution_id FROM institutions WHERE name = 'TON' LIMIT 1;
  END IF;

  -- Create blockchain mapping for TON with chain_id = -15
  IF v_ton_institution_id IS NOT NULL THEN
    INSERT INTO institution_blockchain_mappings (institution_id, chain_id, chain_type, is_active)
    VALUES (v_ton_institution_id, '-15', 'ton', true)
    ON CONFLICT (institution_id) DO NOTHING;
  END IF;

  RAISE NOTICE 'TON institution and mapping added successfully';
END $$;
