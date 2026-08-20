-- SC-459. One ledger of alerts already delivered, and a second mail stream
-- that shares SC-460's unsubscribe token rather than minting its own.

-- ── 1. One token, two streams ────────────────────────────────────────────
--
-- SC-460 shipped `digest_unsubscribe_token` hours ago. A second stream with a
-- second token column would mean two bearer credentials per account, two
-- rotations, and two ways for a user to discover that the link they clicked
-- covered only half their mail. The token identifies the ACCOUNT; which stream
-- a link stops is the endpoint's business.
--
-- The rename is transparent to anything already issued: the VALUE is unchanged
-- and `/e/u/:token` still resolves it. (Nothing has been issued anyway — the
-- digest's first fire is Monday 2026-08-24.)
ALTER TABLE "users" RENAME COLUMN "digest_unsubscribe_token" TO "email_unsubscribe_token";
ALTER INDEX IF EXISTS "idx_users_digest_unsubscribe_token"
  RENAME TO "idx_users_email_unsubscribe_token";

-- Separate from `digest_opt_out_at`, deliberately.
--
-- The two streams are not the same ask. The digest is a summary somebody may
-- reasonably not want. An integration alert says a connection THEY set up has
-- stopped syncing and their net worth is quietly wrong — muting a newsletter
-- is not consent to be shown incorrect figures in silence. So opting out of
-- one does not opt out of the other, and each unsubscribe page links to the
-- other stream's so "stop all of it" is still one extra click rather than a
-- support email.
--
-- Timestamp rather than a boolean, same reasoning as `digest_opt_out_at`:
-- "when" is the first question anyone auditing a complaint asks. NULL means
-- subscribed.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "alerts_opt_out_at" timestamp with time zone;

-- ── 2. The delivery ledger ───────────────────────────────────────────────
--
-- The one thing an alert system must never do is say the same thing twice; the
-- second identical email is what teaches a reader to filter the first. Neither
-- guard already in the codebase covers it. The job's advisory lock stops two
-- OVERLAPPING fires and says nothing about a BullMQ retry of a run that already
-- mailed half its recipients, and `users.digest_last_sent_at` is a per-ACCOUNT
-- cooldown — right for a weekly letter, useless for "tell me about Kraken but
-- not about Kraken again".
--
-- So a row here is one alert that has been claimed or delivered, and the unique
-- index is the whole mechanism:
--
--   `sent_at IS NOT NULL` — delivered. Never sent again while the row lives.
--   `sent_at IS NULL`     — CLAIMED by a sweep that has not finished sending.
--
-- Claiming before sending rather than recording after is what makes a crash
-- safe in the direction that matters: a process that dies mid-send leaves a
-- claim, and a claim suppresses. The cost is that a claim orphaned by a crash
-- would suppress forever, so the sweep re-claims one older than an hour — long
-- after any retry chain has ended, long before the next daily fire.
--
-- A row is DELETED when its condition clears (the integration syncs again),
-- which is what lets the same integration alert a second time if it breaks a
-- second time. "Open alert" and "already told them" are the same row.
--
-- `rule` and `dedupe_key` are text and carry no foreign key on purpose. The key
-- for this rule is a credential id, but the next rule's will be a holding and a
-- date, or a payment occurrence — a column that referenced one of them could
-- only ever serve one rule, and a cascade from the referenced row would delete
-- the record that we notified someone about it.
CREATE TABLE IF NOT EXISTS "alert_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "rule" text NOT NULL,
  "dedupe_key" text NOT NULL,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_alert_deliveries_identity"
  ON "alert_deliveries" ("user_id", "rule", "dedupe_key");

-- The sweep's other two queries are both "every open row for this rule",
-- across all users: the resolve pass and the claim's conflict lookup.
CREATE INDEX IF NOT EXISTS "idx_alert_deliveries_rule"
  ON "alert_deliveries" ("rule");
