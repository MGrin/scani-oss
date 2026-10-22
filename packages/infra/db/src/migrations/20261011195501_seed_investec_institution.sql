-- 20261011195501 — seed Investec institution (SC-1731)
--
-- Investec South Africa Private Bank gets a read-only integration, for
-- self-hosted Scani only: Investec lets a customer's own credentials serve
-- "yourself or your business operations", and a platform serving many clients
-- needs its own onboarding with Investec. The hosted product still lists
-- Investec, so the row is seeded everywhere.
--
-- Named 'Investec' exactly: the integrations router finds a provider's
-- institution by this name (`investecManifest.institutionName`). Keyed by
-- website inside the verified catalogue (the predicate 20260926094529 asks a
-- seed to name).

INSERT INTO institutions (name, type_id, description, website, logo_url, has_integration, is_verified, is_active, created_at, updated_at)
SELECT 'Investec', t.id, 'South African private bank', 'https://www.investec.com', NULL, true, true, true, now(), now()
FROM institution_types t
WHERE t.code = 'bank'
ON CONFLICT (website) WHERE is_verified DO NOTHING;

UPDATE institutions
   SET has_integration = true
 WHERE website = 'https://www.investec.com' AND is_verified;
