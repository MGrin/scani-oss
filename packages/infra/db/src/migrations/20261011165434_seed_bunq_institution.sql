-- 20261011165434 — seed bunq institution (SC-1729)
--
-- bunq gets a read-only integration, for self-hosted Scani only: bunq allows its
-- personal API key only in software the customer runs. The hosted product still
-- lists bunq, so the row is seeded everywhere.
--
-- Named 'bunq', lower case, as the bank writes it: the integrations router finds
-- a provider's institution by this exact name (`bunqManifest.institutionName`).
-- Keyed by website inside the verified catalogue (the predicate
-- 20260926094529 asks a seed to name).

INSERT INTO institutions (name, type_id, description, website, logo_url, has_integration, is_verified, is_active, created_at, updated_at)
SELECT 'bunq', t.id, 'Dutch bank with multi-currency accounts, run entirely from an app', 'https://www.bunq.com', NULL, true, true, true, now(), now()
FROM institution_types t
WHERE t.code = 'bank'
ON CONFLICT (website) WHERE is_verified DO NOTHING;

UPDATE institutions
   SET has_integration = true
 WHERE website = 'https://www.bunq.com' AND is_verified;
