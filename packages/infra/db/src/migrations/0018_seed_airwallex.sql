-- Seed Airwallex (global business banking / payments) as an institution
-- and flip has_integration = true so the integrations grid + balance/tx
-- sync pick it up. Keyed by website for idempotent re-seeds, mirroring
-- the Mercury / Brex neobank batch in 0000_clean_start.sql.

DO $$
DECLARE
    v_bank_type_id uuid;
BEGIN
    SELECT id INTO v_bank_type_id FROM institution_types WHERE code = 'bank';

    INSERT INTO institutions (name, type_id, description, website, logo_url, is_active, created_at, updated_at) VALUES
      ('Airwallex', v_bank_type_id, 'Hong Kong-headquartered global financial platform offering multi-currency business accounts, payments and FX', 'https://www.airwallex.com', NULL, true, now(), now())
    ON CONFLICT (website) DO NOTHING;

    UPDATE institutions
       SET has_integration = true
     WHERE website = 'https://www.airwallex.com';
END $$;
