-- 20261001080323 — foundation evidence columns
-- Foundation A1, task 2. The columns the feeds model needs on the three tables
-- it reads: how a holding is kept (`kind`, `starts_at`, `value_base`,
-- `value_priced_at`), what an observation is evidence of (`role`, `authority`,
-- `input_id`, `cause`, `superseded_at`), and what the ledger says about a row
-- beyond the legacy `kind` (`ledger_kind`, `kind_subtype`, `group_id`,
-- `fee_of`, `input_id`, `execution_price*`, `kind_origin`, `decision_id`).
-- Nothing reads or writes them yet.
--
-- Every column is nullable with no default, and every constraint is NOT VALID.
-- `SettlementAnswerReviewService.restoreRows` re-inserts captured `to_jsonb`
-- rows naming every Drizzle column, and a bundle captured before this
-- migration has no key for a new one, so it inserts NULL explicitly: a NOT NULL
-- column would break Undo on every retired gap answer that already exists. NOT
-- VALID also skips the scan over `holding_balance_observations` and its lock,
-- and still enforces each constraint on every row written from here on.
-- Validating, and NOT NULL, belong to A5.
--
-- `holding_transactions.kind` is left alone: the lot walker and the returns
-- classifier switch on its strings. The mapped kind goes in `ledger_kind`.
-- `fee_of` has no FK because it may name an entry or a group.
--
-- Each new foreign key on the two big tables gets a partial index on its
-- non-NULL rows: deleting an input, a decision or a token runs its SET NULL
-- by that column, and would otherwise scan the whole table once per parent.
-- The columns are all NULL here, so each build reads the table once and
-- writes an empty index.

-- Lock waits are bounded. The runner applies every pending migration in one
-- transaction, so this holds until it commits: a deploy queued behind an open
-- transaction fails with 55P03 and is retried, instead of holding every later
-- query on these tables behind it.
SET LOCAL lock_timeout = '5s';

ALTER TABLE holdings
  ADD COLUMN kind text,
  ADD COLUMN starts_at timestamptz,
  ADD COLUMN value_base text,
  ADD COLUMN value_priced_at timestamptz;

ALTER TABLE holdings
  ADD CONSTRAINT holdings_kind_chk CHECK (kind IN ('snapshot', 'feed')) NOT VALID;

ALTER TABLE holding_balance_observations
  ADD COLUMN role text,
  ADD COLUMN authority text,
  ADD COLUMN input_id uuid,
  ADD COLUMN cause text,
  ADD COLUMN superseded_at timestamptz;

ALTER TABLE holding_balance_observations
  ADD CONSTRAINT holding_obs_role_chk
    CHECK (role IN ('snapshot', 'checkpoint', 'verification')) NOT VALID,
  ADD CONSTRAINT holding_obs_authority_chk
    CHECK (authority IN ('provider', 'statement', 'person')) NOT VALID,
  ADD CONSTRAINT holding_obs_cause_chk
    CHECK (cause IN ('flow', 'growth', 'correction')) NOT VALID,
  ADD CONSTRAINT holding_obs_input_fk
    FOREIGN KEY (input_id) REFERENCES feed_inputs(id) ON DELETE SET NULL NOT VALID;

ALTER TABLE holding_transactions
  ADD COLUMN ledger_kind text,
  ADD COLUMN kind_subtype text,
  ADD COLUMN group_id uuid,
  ADD COLUMN fee_of uuid,
  ADD COLUMN input_id uuid,
  ADD COLUMN execution_price text,
  ADD COLUMN execution_price_token_id uuid,
  ADD COLUMN kind_origin text,
  ADD COLUMN decision_id uuid;

ALTER TABLE holding_transactions
  ADD CONSTRAINT holding_tx_ledger_kind_chk CHECK (ledger_kind IN (
    'inflow',
    'outflow',
    'transfer_in',
    'transfer_out',
    'trade_leg',
    'fee',
    'income',
    'corporate_action',
    'derivative_pnl',
    'unexplained_difference'
  )) NOT VALID,
  ADD CONSTRAINT holding_tx_kind_subtype_chk CHECK (kind_subtype IN (
    'interest',
    'staking',
    'dividend',
    'apy',
    'airdrop',
    'reward'
  )) NOT VALID,
  ADD CONSTRAINT holding_tx_kind_origin_chk
    CHECK (kind_origin IN ('source', 'rule', 'jev', 'person', 'mirror')) NOT VALID,
  ADD CONSTRAINT holding_tx_input_fk
    FOREIGN KEY (input_id) REFERENCES feed_inputs(id) ON DELETE SET NULL NOT VALID,
  ADD CONSTRAINT holding_tx_exec_token_fk
    FOREIGN KEY (execution_price_token_id) REFERENCES tokens(id) ON DELETE SET NULL NOT VALID,
  ADD CONSTRAINT holding_tx_decision_fk
    FOREIGN KEY (decision_id) REFERENCES judgment_decisions(id) ON DELETE SET NULL NOT VALID;

CREATE INDEX IF NOT EXISTS idx_holding_obs_input_id
  ON holding_balance_observations (input_id) WHERE input_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_holding_tx_input_id
  ON holding_transactions (input_id) WHERE input_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_holding_tx_decision_id
  ON holding_transactions (decision_id) WHERE decision_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_holding_tx_execution_price_token_id
  ON holding_transactions (execution_price_token_id) WHERE execution_price_token_id IS NOT NULL;

-- `feed_inputs`, `feed_match_rules` and `outbox_events` are keyed on `users.id`
-- with no index on it (`judgment_decisions` leads its unique key with it), and
-- the cascade from `users` walks each of them by that column.
CREATE INDEX IF NOT EXISTS idx_feed_inputs_user_id ON feed_inputs (user_id);
CREATE INDEX IF NOT EXISTS idx_feed_match_rules_user_id ON feed_match_rules (user_id);
CREATE INDEX IF NOT EXISTS idx_outbox_events_user_id ON outbox_events (user_id);
