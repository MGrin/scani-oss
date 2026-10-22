-- 20261011203415 — seed Fio banka institution (SC-1732)
--
-- Fio banka (Czech Republic and Slovakia) gets a read-only integration, for
-- self-hosted Scani only: Fio holds the customer liable for any use of the API
-- token by someone else, and hosted use would likely need an account-information
-- licence. The hosted product still lists Fio banka, so the row is seeded
-- everywhere.
--
-- Named 'Fio banka' exactly: the integrations router finds a provider's
-- institution by this name (`fioManifest.institutionName`). Keyed by website
-- inside the verified catalogue (the predicate 20260926094529 asks a seed to
-- name).

INSERT INTO institutions (name, type_id, description, website, logo_url, has_integration, is_verified, is_active, created_at, updated_at)
SELECT 'Fio banka', t.id, 'Czech and Slovak bank', 'https://www.fio.cz', NULL, true, true, true, now(), now()
FROM institution_types t
WHERE t.code = 'bank'
ON CONFLICT (website) WHERE is_verified DO NOTHING;

UPDATE institutions
   SET has_integration = true
 WHERE website = 'https://www.fio.cz' AND is_verified;
