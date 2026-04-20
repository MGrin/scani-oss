-- Make users.email NOT NULL.
-- Existing rows with NULL email get backfilled to '' (pre-migration behavior
-- already wrote '' when Supabase JWT had no email). Future user creation must
-- pass a non-null email; the auth middleware now rejects otherwise.

UPDATE "users" SET "email" = '' WHERE "email" IS NULL;

ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL;
