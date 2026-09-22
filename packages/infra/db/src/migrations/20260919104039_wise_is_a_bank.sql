-- 20260919104039 — wise is a bank
-- 0000_clean_start seeded Wise as `other`, so the Integrations screen listed it
-- as "Other" beside Airwallex's "Bank" (0018), though both hold multi-currency
-- cash balances. Nothing branches on the type except that label (SC-1257).
-- Keyed by website, as the seeds are.
UPDATE institutions
   SET type_id = (SELECT id FROM institution_types WHERE code = 'bank'),
       updated_at = now()
 WHERE website = 'https://www.wise.com';
