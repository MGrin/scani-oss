-- SC-957 — a change of cost-basis method leaves a record of itself.
--
-- `users.cost_basis_method` (SC-462) decides which lots a disposal is matched
-- against, so changing it changes every realized figure the account has ever
-- been shown. Nothing recorded that the change happened, and that absence is
-- what made it unrecoverable rather than merely surprising: a figure that moved
-- had no explanation available to the user or to us.
--
-- mgrin decided on 2026-09-03 that the method stays FREELY CHANGEABLE. Locking
-- it outright, and locking it only for periods already shown, were both weighed
-- and declined — FIFO against HMRC-verified section 104 is exactly the decision
-- someone gets wrong on day one, and freezing it punishes the person least
-- equipped to have made it. So this table does not restrain the change. It makes
-- the change EXPLICABLE: what it was, what it became, when, and by whom.
--
-- ## Why a table and not `users.cost_basis_method_changed_at`
--
-- A column holds the LAST change. The question a moved figure raises is "which
-- method was this computed under", and answering it needs the whole sequence:
-- an account that went fifo -> s104 -> fifo has figures from three eras and one
-- timestamp cannot separate them. Append-only, one row per transition.
--
-- ## Why a row cannot record a non-change
--
-- `previous_method <> new_method` is a CHECK rather than a caller's discipline.
-- A row saying fifo became fifo explains nothing and would dilute the only
-- reading this table has: every row here moved somebody's figures. The write
-- path skips the no-op too — the constraint is what makes that not merely
-- a habit.
--
-- ## Why `source` is CHECK-constrained to one value
--
-- "By whom" has exactly one honest answer today: the account owner, through the
-- profile mutation, which is the only writer of the column
-- (`UserService.updateUser`, reached only by `users.updateCurrent`). A nullable
-- actor column that is always the same user records nothing. A one-value CHECK
-- records the same fact and makes a SECOND writer impossible to add silently —
-- adding a support or admin path costs a migration, which is the loud step.
CREATE TABLE IF NOT EXISTS user_cost_basis_method_changes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  previous_method text NOT NULL,
  new_method      text NOT NULL,
  source          text NOT NULL,
  -- clock_timestamp(), NOT now(). `now()` is transaction_timestamp() and is
  -- CONSTANT for the whole transaction, so two changes committed together would
  -- carry the same instant and `ORDER BY changed_at DESC` could not say which
  -- era followed which — the one question this table exists to answer.
  changed_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT user_cost_basis_method_changes_previous_method_check
    CHECK (previous_method IN ('fifo', 'uk_section_104')),
  CONSTRAINT user_cost_basis_method_changes_new_method_check
    CHECK (new_method IN ('fifo', 'uk_section_104')),
  CONSTRAINT user_cost_basis_method_changes_is_a_change
    CHECK (previous_method <> new_method),
  CONSTRAINT user_cost_basis_method_changes_source_check
    CHECK (source IN ('user_profile_update'))
);

-- The only query this table has: "what has this account's method been, newest
-- first". Descending because the answer to "which method was that figure
-- computed under" is found by walking back from now, not forward from signup.
CREATE INDEX IF NOT EXISTS idx_user_cost_basis_method_changes_user_changed_at
  ON user_cost_basis_method_changes (user_id, changed_at DESC);

COMMENT ON COLUMN user_cost_basis_method_changes.previous_method IS
  'The method every figure computed BEFORE changed_at was matched under. The two method columns carry the same CHECK as users.cost_basis_method: a value this table admits and that column refuses would describe an era that never existed.';
COMMENT ON COLUMN user_cost_basis_method_changes.new_method IS
  'The method in force from changed_at until the next row, or until now if this is the newest.';
COMMENT ON COLUMN user_cost_basis_method_changes.source IS
  'Which write path made the change. One value today (user_profile_update) and CHECK-constrained to it, so a second writer cannot be added without a migration saying so.';
COMMENT ON COLUMN user_cost_basis_method_changes.changed_at IS
  'When the method changed. The boundary between two eras of realized figures — figures at or after this instant are computed under new_method.';
