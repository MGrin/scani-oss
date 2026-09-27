-- 20260926094529 — institution owner and verified flag (SC-1354)
--
-- `institutions` was one catalogue that every user could write to and read all
-- of: a name one user typed showed up in every other user's picker, and was
-- reused for them by name. A row a user creates now belongs to that user until
-- it is verified. What the migrations seeded is the verified catalogue.

ALTER TABLE institutions ADD COLUMN is_verified boolean NOT NULL DEFAULT false;
ALTER TABLE institutions
  ADD COLUMN created_by_user_id uuid REFERENCES users(id) ON DELETE CASCADE;

-- Verified is what migrations put there. `0000_clean_start` inserts its whole
-- catalogue in one transaction, so every one of those rows carries that
-- transaction's `now()`. The later seed (Airwallex) has an integration; chains
-- have a blockchain mapping. No user-facing path can set either.
UPDATE institutions i SET is_verified = true
WHERE i.created_at = (SELECT min(created_at) FROM institutions)
   OR i.has_integration
   OR EXISTS (
     SELECT 1 FROM institution_blockchain_mappings m WHERE m.institution_id = i.id
   );

-- A row several users already hang accounts off stays shared. Hiding it would
-- take it away from people using it; the leak it represents has happened.
UPDATE institutions i SET is_verified = true
WHERE NOT i.is_verified
  AND (SELECT count(DISTINCT a.user_id) FROM accounts a WHERE a.institution_id = i.id) > 1;

-- Everything left was typed by a user, so it belongs to the one user whose
-- accounts use it. A row nobody uses keeps no owner and is visible to nobody.
UPDATE institutions i SET created_by_user_id = (
  SELECT min(a.user_id::text)::uuid FROM accounts a WHERE a.institution_id = i.id
)
WHERE NOT i.is_verified;

-- A website stays unique inside the catalogue and inside one user's own rows,
-- so two users can each type the same site without sharing a row. A seed that
-- used `ON CONFLICT (website)` must now name the predicate:
-- `ON CONFLICT (website) WHERE is_verified DO NOTHING`, and set is_verified.
ALTER TABLE institutions DROP CONSTRAINT institutions_website_unique;
CREATE UNIQUE INDEX institutions_verified_website_unique
  ON institutions (website) WHERE is_verified;
CREATE UNIQUE INDEX institutions_owner_website_unique
  ON institutions (created_by_user_id, website) WHERE NOT is_verified;
CREATE INDEX idx_institutions_created_by_user_id ON institutions (created_by_user_id);
