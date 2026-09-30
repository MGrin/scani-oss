-- One account: the Cloud console signs in with the app's account, so every
-- Cloud key, tenant and usage subject becomes a `users.id`.
--
-- A verified `cloud_users` row maps to the `users` row with the same
-- `lower(email)`; an unverified one maps to nothing. Nothing is dropped:
-- a key whose owner cannot be mapped aborts the whole migration.
--
-- 1. A verified `cloud_users` row with no `users` row of that address gets
--    one. `DISTINCT ON (lower(email))` because `cloud_users.email` is unique
--    case-sensitively and `users` is unique on `lower(email)`. These rows skip
--    Better-Auth's `user.create.after` hook, so the one thing it writes that
--    the app needs is replicated here: the default base currency (USD fiat),
--    without which the first authenticated request fails. Signup source,
--    analytics and founder alerts are attribution, not requirements.
--    The address is stored lowercased: Better-Auth lowercases the address it
--    looks up and compares it exactly, so `Me@x.com` could never sign in.
-- 2. A `users` row that is unverified but matches a verified `cloud_users`
--    address becomes verified — the cloud side already proved control of that
--    mailbox, and leaving it unverified would abort this deploy below.
-- 3. A merged pair keeps the EARLIEST `created_at` across the `users` row and
--    every case variant in `cloud_users` — the beta promise counts the
--    earliest sign-up.
-- 4. Keys move from `cloud_users` to `users`: owner and tenant.
-- 5. Usage rows whose subject was a mapped `cloud_users.id` take the
--    `users.id`. Other subjects are left alone.
--
-- The four `cloud_*` auth tables stay; a later deploy drops them.

INSERT INTO "users" ("email", "name", "email_verified", "created_at", "base_currency_id")
SELECT DISTINCT ON (lower(c."email"))
  lower(c."email"),
  COALESCE(c."name", ''),
  c."email_verified",
  c."created_at",
  (
    SELECT t."id"
    FROM "tokens" AS t
    JOIN "token_types" AS tt ON tt."id" = t."type_id"
    WHERE t."symbol" = 'USD' AND tt."code" = 'fiat'
    LIMIT 1
  )
FROM "cloud_users" AS c
WHERE c."email_verified"
  AND NOT EXISTS (SELECT 1 FROM "users" AS u WHERE lower(u."email") = lower(c."email"))
ORDER BY lower(c."email"), c."created_at", c."id";
--> statement-breakpoint

UPDATE "users" AS u
SET "email_verified" = true
WHERE NOT u."email_verified"
  AND EXISTS (
    SELECT 1 FROM "cloud_users" AS c
    WHERE lower(c."email") = lower(u."email") AND c."email_verified"
  );
--> statement-breakpoint

UPDATE "users" AS u
SET "created_at" = least(u."created_at", m."min_created_at")
FROM (
  SELECT lower("email") AS "email", min("created_at") AS "min_created_at"
  FROM "cloud_users"
  WHERE "email_verified"
  GROUP BY 1
) AS m
WHERE m."email" = lower(u."email")
  AND u."email_verified"
  AND m."min_created_at" < u."created_at";
--> statement-breakpoint

ALTER TABLE "cloud_api_keys" DROP CONSTRAINT "cloud_api_keys_owner_user_id_cloud_users_id_fk";
--> statement-breakpoint

UPDATE "cloud_api_keys" AS k
SET "owner_user_id" = u."id", "tenant_id" = u."id"
FROM "cloud_users" AS c
JOIN "users" AS u
  ON lower(u."email") = lower(c."email")
  AND u."email_verified"
WHERE k."owner_user_id" = c."id"
  AND c."email_verified";
--> statement-breakpoint

DO $$
DECLARE
  unmapped integer;
BEGIN
  SELECT count(*) INTO unmapped
  FROM "cloud_api_keys" AS k
  WHERE NOT EXISTS (SELECT 1 FROM "users" AS u WHERE u."id" = k."owner_user_id");
  IF unmapped > 0 THEN
    RAISE EXCEPTION 'cloud_api_keys owner has no users row: % key(s) could not be mapped', unmapped;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "cloud_api_keys"
  ADD CONSTRAINT "cloud_api_keys_owner_user_id_users_id_fk"
  FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

UPDATE "cloud_usage_events" AS e
SET "subject" = u."id"::text
FROM "cloud_users" AS c
JOIN "users" AS u
  ON lower(u."email") = lower(c."email")
  AND u."email_verified"
WHERE e."subject" = c."id"::text
  AND c."email_verified";
