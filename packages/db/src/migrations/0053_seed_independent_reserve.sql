-- Seed Independent Reserve (Australian crypto exchange) as an institution
-- and flip has_integration = true so the IntegrationManager + cron sync
-- pick it up. Keyed by website for idempotent re-seeds.

DO $$
DECLARE
    v_crypto_exchange_type_id uuid;
BEGIN
    SELECT id INTO v_crypto_exchange_type_id FROM institution_types WHERE code = 'crypto_exchange';

    INSERT INTO institutions (name, type_id, description, website, logo_url, is_active, created_at, updated_at) VALUES
      ('Independent Reserve', v_crypto_exchange_type_id, 'Australian cryptocurrency exchange founded in 2013, AUSTRAC-registered and ISO 27001 certified', 'https://www.independentreserve.com', NULL, true, now(), now())
    ON CONFLICT (website) DO NOTHING;

    UPDATE institutions
       SET has_integration = true
     WHERE website = 'https://www.independentreserve.com';
END $$;
