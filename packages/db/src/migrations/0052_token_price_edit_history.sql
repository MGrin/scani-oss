-- Append-only audit trail of manual price edits on custom tokens
-- (token types 'private-company' and 'other'). Keeps a forensic record
-- of who changed a custom token's price, from what to what, and why.
-- Unlocks later abuse detection and moderation without schema changes.

CREATE TABLE IF NOT EXISTS "token_price_edit_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "token_id" uuid NOT NULL REFERENCES "tokens"("id") ON DELETE CASCADE,
  "base_token_id" uuid NOT NULL REFERENCES "tokens"("id") ON DELETE RESTRICT,
  "previous_price" text,
  "new_price" text NOT NULL,
  "edited_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_token_price_edit_history_token_created"
  ON "token_price_edit_history" ("token_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_token_price_edit_history_user_created"
  ON "token_price_edit_history" ("edited_by_user_id", "created_at" DESC);
