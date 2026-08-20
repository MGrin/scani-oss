-- SC-226. Web Push subscriptions, and the timezone the reminder needs.
--
-- `users.timezone` is an IANA zone name (`Asia/Makassar`, `Europe/London`),
-- reported by the browser via `Intl.DateTimeFormat().resolvedOptions().timeZone`
-- and stored on sign-in. That is the only honest source available: nothing in
-- the account, the payment data, or the request tells us where a person is,
-- and an IP guess is wrong exactly when someone travels — which is when a
-- 17:00 reminder arriving at 04:00 is most annoying.
--
-- **NULLABLE, and the job skips a NULL rather than defaulting to UTC.**
-- Defaulting looks harmless and is not: for a user in Singapore, "17:00 UTC"
-- is 01:00, so the default silently converts a useful feature into a
-- middle-of-the-night alarm. A user with no timezone yet gets no reminder,
-- which is visibly nothing rather than invisibly wrong. It fills itself in
-- the first time they open the app after this ships.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "timezone" text;

COMMENT ON COLUMN "users"."timezone" IS
  'IANA zone from the browser, e.g. Asia/Makassar. NULL = not reported yet; the reminder job skips these rather than assuming UTC. SC-226.';

-- One row per push endpoint, which means per browser per device. A person
-- with the PWA on a phone and a laptop has two, and both should fire.
--
-- `endpoint` is the primary identity: the push service issues it, it is
-- already unique, and it is what a delete has to match when the service tells
-- us a subscription is gone (404/410 on send). Storing our own id as PK and
-- uniquing the endpoint keeps the FK story ordinary.
CREATE TABLE IF NOT EXISTS "push_subscriptions" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"    uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "endpoint"   text NOT NULL,
  -- The two halves of the client's public key, base64url. Web Push encrypts
  -- to these; without both, a send is impossible. They are not secrets in the
  -- credential sense — they are the recipient's public key — but they are
  -- per-device identifiers and are treated as personal data.
  "p256dh"     text NOT NULL,
  "auth"       text NOT NULL,
  -- What the browser said it was, for support. Not used in any decision.
  "user_agent" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  -- Last time a send to this endpoint succeeded. A row that has not succeeded
  -- in a long time is a candidate for pruning, but nothing prunes yet — see
  -- the note in PushSubscriptionRepository.
  "last_sent_at" timestamptz,
  CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE ("endpoint")
);

CREATE INDEX IF NOT EXISTS "idx_push_subscriptions_user" ON "push_subscriptions" ("user_id");
