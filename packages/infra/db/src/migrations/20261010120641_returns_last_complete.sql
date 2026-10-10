-- 20261010120641 — returns last complete
--
-- THE LAST ELIGIBLE RETURNS ANSWER, SHOWN WHILE A HISTORY REBUILD RUNS (SC-1694).
--
-- An import queues a portfolio-history rebuild, and until it finishes
-- `portfolio.getReturns` withholds every figure as `rebuilding-history`. A
-- rebuild has run for hours (SC-1607), so the card sat empty that long. The
-- api keeps the last eligible answer per (user, scope, window) here and serves
-- it as `lastComplete`, "as of" `computed_at`.
--
-- Derived: losing every row only means an empty card during the next rebuild,
-- as before. Deleted with the user.
CREATE TABLE returns_last_complete (
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The request's scope as JSON, e.g. {"kind":"user"}.
  scope_key        text NOT NULL,
  -- `ytd`, `1y`, `all`, or `custom:<days>d` for a custom window of that length.
  window_key       text NOT NULL,
  base_currency_id text NOT NULL,
  -- `{ returns, benchmarks }` exactly as `getReturns` sent it.
  answer           jsonb NOT NULL,
  computed_at      timestamptz NOT NULL,
  PRIMARY KEY (user_id, scope_key, window_key)
);
