-- SC-1160. A user's own scam verdict on a token, for that user only.
--
-- mgrin, 2026-09-14: "this token must be marked as a scam for that specific
-- user only. Then it must go into a table, and if a lot of users marked it as a
-- scam we will take a decision to mark it as scam globally." So a verdict here
-- overrides `tokens.is_scam_probability` for its own user when their holdings
-- are read, and never writes `tokens`. Promotion to a global verdict stays a
-- human act; nothing aggregates this table into the shared score.
--
-- Before this, `tokens.unmarkAsScam` wrote `is_scam_probability = 0,
-- scam_score_source = 'user'` on the shared row, which the rescorer never
-- recomputes — one user's click un-flagged a token for everyone, permanently.
-- Converting those rows is a separate migration, because the old write recorded
-- no user and the conversion is a decision in its own right.
CREATE TABLE IF NOT EXISTS "user_token_scam_verdicts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_id" uuid NOT NULL REFERENCES "tokens"("id") ON DELETE CASCADE,
  "verdict" text NOT NULL,
  "source" text DEFAULT 'user' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_token_scam_verdicts_user_id_token_id_unique" UNIQUE ("user_id", "token_id"),
  CONSTRAINT "user_token_scam_verdicts_verdict_check" CHECK ("verdict" IN ('scam', 'not_scam')),
  CONSTRAINT "user_token_scam_verdicts_source_check" CHECK ("source" IN ('user', 'migrated'))
);

-- Read by (user, token) on every holdings query — the unique index serves it —
-- and by token for the per-token counts a human reads before a global decision.
CREATE INDEX IF NOT EXISTS "idx_user_token_scam_verdicts_token_id"
  ON "user_token_scam_verdicts" ("token_id");
