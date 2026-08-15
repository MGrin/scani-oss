-- SC-138. `action_taken_at` was the only thing that could clear a job from
-- the review queue, and only `createHoldingsBatch` ever set it — so a parse
-- the user did not want had no way out, and the queue badge trained people
-- to ignore it.
--
-- Discarding needs its own recorded outcome rather than a bare stamp: the
-- job page reads this back, and telling someone their junk upload was
-- "imported" is the same class of false claim the stamp was meant to end.
-- NULL = not acted on yet, which is what every existing stamped row means
-- prior to this column; those are backfilled to 'imported' because the only
-- writer that could have stamped them was a successful import.
ALTER TABLE "user_jobs" ADD COLUMN IF NOT EXISTS "review_outcome" text;

UPDATE "user_jobs"
SET "review_outcome" = 'imported'
WHERE "action_taken_at" IS NOT NULL AND "review_outcome" IS NULL;
