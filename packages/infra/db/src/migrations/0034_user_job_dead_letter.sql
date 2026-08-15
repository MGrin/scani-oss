-- SC-153. `state = 'failed'` meant three different things at once: an attempt
-- that failed and WILL retry (the processor writes it on every attempt), a job
-- that is terminally dead, and a user cancellation. The Jobs list could not
-- tell them apart, so a dead job and a running one looked identical — which is
-- the whole defect: the system knew, the interface reassured.
--
-- `dead_at` is the one representation of "this will not run again". Not a new
-- `user_job_state` enum value, deliberately: an unknown state falls through the
-- existing `switch` in every reader and renders NOTHING, which is the exact
-- failure mode this migration exists to end. Every current reader keeps seeing
-- 'failed' and stays correct; the new column only adds a claim.
--
-- `failure_reason` says which kind, because the sentence the user needs differs:
--   retries_exhausted — tried every attempt, all failed
--   unrecoverable     — classified by-design failure (bad credentials, wrong
--                       file), BullMQ's UnrecoverableError; no retry attempted
--   never_delivered   — the row was written but the job never reached Redis
--                       (api crashed between insert and queue.add); the orphan
--                       reconciler owns these
--   cancelled         — the user stopped it
ALTER TABLE "user_jobs" ADD COLUMN IF NOT EXISTS "dead_at" timestamptz;
ALTER TABLE "user_jobs" ADD COLUMN IF NOT EXISTS "failure_reason" text;

-- The review feed reads exactly this shape: dead, not yet acted on. Partial so
-- it stays small — the overwhelming majority of rows are not dead.
CREATE INDEX IF NOT EXISTS "idx_user_jobs_user_dead"
  ON "user_jobs" ("user_id", "dead_at")
  WHERE "dead_at" IS NOT NULL AND "action_taken_at" IS NULL;

-- Backfill. Rows already in the table are the ones someone has been staring at,
-- so leaving them mislabelled would miss the people this is for. Each branch
-- below is decided by evidence already on the row; nothing is guessed.

-- 1. Cancellations. `markCancelled` writes this exact sentinel and nothing else
--    does. Terminal by definition, and already stamped `action_taken_at`, so it
--    is dead but never reaches the review feed.
UPDATE "user_jobs"
SET "dead_at" = COALESCE("finished_at", "updated_at"), "failure_reason" = 'cancelled'
WHERE "state" = 'failed' AND "dead_at" IS NULL AND "error" = 'Cancelled by user';

-- 2. Never delivered. The orphan reconciler's message is its own signature.
UPDATE "user_jobs"
SET "dead_at" = COALESCE("finished_at", "updated_at"), "failure_reason" = 'never_delivered'
WHERE "state" = 'failed' AND "dead_at" IS NULL AND "error" LIKE 'Enqueue reconciler:%';

-- 3. Retries exhausted. The processor writes attempts_made on every failure, so
--    a row whose last write reached its own ceiling had no attempt left.
UPDATE "user_jobs"
SET "dead_at" = COALESCE("finished_at", "updated_at"), "failure_reason" = 'retries_exhausted'
WHERE "state" = 'failed' AND "dead_at" IS NULL AND "attempts_made" >= "attempts_allowed";

-- 4. Stalled mid-retry. attempts_made < attempts_allowed reads as "a retry is
--    coming", and for a row that failed seconds ago it is. But the longest
--    backoff any descriptor uses is RETRY_HEAVY's 30s exponential over 2
--    attempts, so a retry more than an hour late is a retry that is never
--    coming — the worker was replaced, or BullMQ evicted the job. An hour is
--    ~100x the longest real wait; anything newer is left NULL and the live path
--    decides it correctly within minutes.
UPDATE "user_jobs"
SET "dead_at" = COALESCE("finished_at", "updated_at"), "failure_reason" = 'retries_exhausted'
WHERE "state" = 'failed'
  AND "dead_at" IS NULL
  AND COALESCE("finished_at", "updated_at") < now() - interval '1 hour';
