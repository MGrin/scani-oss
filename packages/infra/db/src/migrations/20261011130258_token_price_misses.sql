-- 20261011130258 — a day no historical price provider had, remembered so the
-- backfill does not ask again until the check is a week old (SC-1725).
CREATE TABLE token_price_misses (
  token_id uuid NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  base_token_id uuid NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  day date NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (token_id, base_token_id, day)
);
