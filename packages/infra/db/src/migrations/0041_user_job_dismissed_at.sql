-- SC-292. Two document uploads failed permanently on 2026-08-11 and left no
-- record any reader can see. Four DLQ entries, two documents, every one
-- `failedReason: "The specified key does not exist."` — and not one matching
-- row in `user_jobs`. Across all time every `document-parse` row is
-- `completed`; the table has never recorded a failure of that job.
--
-- The rows were not missing because they were written late. The enqueue mirror
-- inserts BEFORE `queue.add`, so a row exists from the moment a job is
-- accepted. They are missing because `jobs.remove` — "clear this out of my
-- failed list" — was a hard DELETE.
--
-- That makes dismissal indistinguishable from never having happened. A person
-- looking at their jobs list sees fourteen completed parses and no hint that
-- two more were attempted, and they still hold the document: if they knew the
-- parse had failed they would upload it again, but silence reads as "I already
-- did that one". Instance 16 in docs/technical/2026-08-15_absence-and-refusal.md.
--
-- Dismissal is a REFUSAL — "I have seen this and I am done with it" — and a
-- refusal has to leave a mark. The row now survives with `dismissed_at` set;
-- the listing queries hide it, so the user still gets the empty failed list
-- they asked for, but the fact is no longer destroyed.
ALTER TABLE "user_jobs" ADD COLUMN IF NOT EXISTS "dismissed_at" timestamptz;

COMMENT ON COLUMN "user_jobs"."dismissed_at" IS
  'Set when the user cleared a failed job from their list. The row is kept: dismissal is a refusal, not an absence. NULL = not dismissed. SC-292.';

-- Partial, because every query that reads this column asks the same question
-- — "not dismissed" — and that is the overwhelming majority of rows.
CREATE INDEX IF NOT EXISTS "idx_user_jobs_not_dismissed"
  ON "user_jobs" ("user_id", "created_at")
  WHERE "dismissed_at" IS NULL;
