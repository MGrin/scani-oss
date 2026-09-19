-- SC-1160. Turn every GLOBAL user verdict into per-user ones, and hand the
-- shared score back to the rescorer.
--
-- Until SC-1160, `tokens.unmarkAsScam` wrote `is_scam_probability = 0,
-- scam_score_source = 'user'` on the shared row (and the deleted `markAsScam`
-- wrote 1.0), which the rescorer never recomputes. mgrin ruled 2026-09-19
-- (Operator #11154, #11164) that each becomes a per-user verdict and the
-- shared score returns to the rescorer.
--
-- **The old write recorded no user**, so "the user who set it" cannot be
-- recovered from the database — the id survives only in a log line. The
-- ruling (option a) is therefore: every CURRENT HOLDER of such a token gets a
-- verdict matching the value they see today, tagged `migrated`. Nobody's
-- totals move on the day this runs, which is what makes it safe to do without
-- asking each of them; the tag keeps these distinguishable from a verdict a
-- person actually gave, for whoever reads the table before a global decision.
--
-- The value decides the verdict rather than assuming every row was a clear:
-- a row at or over 0.35 (`SCAM_PROBABILITY_THRESHOLD`) came from the deleted
-- `markAsScam` and becomes `scam`.
--
-- A verdict a holder already gave through the new procedures wins: ON
-- CONFLICT DO NOTHING. Idempotent — a second run finds no `user` rows.
INSERT INTO "user_token_scam_verdicts" ("user_id", "token_id", "verdict", "source")
SELECT DISTINCT
  h."user_id",
  t."id",
  CASE WHEN t."is_scam_probability" >= 0.35 THEN 'scam' ELSE 'not_scam' END,
  'migrated'
FROM "tokens" t
JOIN "holdings" h ON h."token_id" = t."id"
WHERE t."scam_score_source" = 'user'
ON CONFLICT ("user_id", "token_id") DO NOTHING;

-- Back to the rescorer. It recomputes crypto rows whose source is `heuristic`
-- and whose version is stale, so a NULL version queues each one for the next
-- nightly run; until then the old value stands, and every holder is already
-- pinned to it by their verdict above. Every other type is never scored, so
-- its right state is `unscored` at 0 — the default a new row of that type gets.
UPDATE "tokens" t
SET
  "scam_score_source" = CASE WHEN tt."code" = 'crypto' THEN 'heuristic' ELSE 'unscored' END,
  "scam_score_version" = NULL,
  "is_scam_probability" = CASE WHEN tt."code" = 'crypto' THEN t."is_scam_probability" ELSE 0 END,
  "updated_at" = now()
FROM "token_types" tt
WHERE tt."id" = t."type_id"
  AND t."scam_score_source" = 'user';
