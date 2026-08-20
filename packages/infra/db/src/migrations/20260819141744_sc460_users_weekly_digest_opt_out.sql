-- SC-460. Three columns the weekly digest cannot be sent without.
--
-- `digest_unsubscribe_token` is a BEARER CREDENTIAL, and that is why it is not
-- `users.id`. The id is already unguessable, so reusing it would work — and it
-- also appears in API responses, logs and screenshots, so the day one leaks is
-- the day anyone holding it can unsubscribe that account. A column that exists
-- for one purpose can be rotated for that purpose alone. NOT NULL with a
-- default so every existing row gets one now: a lazily-minted token would be
-- NULL on exactly the accounts that have never been mailed, which is all 15.
--
-- `digest_opt_out_at` is a timestamp rather than a boolean because "when" is
-- the question anyone auditing a complaint will ask, and a boolean cannot
-- answer it. NULL means subscribed.
--
-- `digest_last_sent_at` is the retry guard. The job's advisory lock stops two
-- OVERLAPPING fires, which is a different thing from stopping a second send: a
-- run that mailed half the users and then threw is retried by BullMQ, takes the
-- lock cleanly because the first attempt has ended, and mails everyone it
-- already reached a second time. Same reasoning as `push_subscriptions.
-- last_sent_at` (SC-226).
--
-- Deliberately NOT backfilled with a send date. Nothing has ever mailed a
-- digest, so NULL here is true rather than unknown.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "digest_unsubscribe_token" uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS "digest_opt_out_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "digest_last_sent_at" timestamp with time zone;

-- Unique because the token is the whole of what the unsubscribe endpoint
-- authenticates on, and an index because that endpoint's only query is a
-- lookup by it.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_digest_unsubscribe_token"
  ON "users" ("digest_unsubscribe_token");
