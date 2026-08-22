-- SC-551. Split the failure message by audience.
--
-- `user_jobs.error` keeps whatever the processor threw, verbatim, because the
-- admin user-jobs page renders it and an operator diagnosing a failure needs
-- exactly that. What reaches the job's OWNER is only a message a processor
-- marked `userFacing(...)`, and it lands here.
--
-- Nullable with no backfill, deliberately. Null means "nobody wrote this for a
-- reader", which is the correct reading of every historical row: none of them
-- was ever marked, and inferring intent from the stored text is the mistake
-- this column exists to stop — an internal assertion can read as a perfectly
-- tidy sentence, so any text-shape heuristic passes the cases it must catch.
-- Rows written before this migration therefore show the owner a translated
-- failure category instead, which is what they should have shown all along.

ALTER TABLE user_jobs ADD COLUMN IF NOT EXISTS user_facing_error text;
