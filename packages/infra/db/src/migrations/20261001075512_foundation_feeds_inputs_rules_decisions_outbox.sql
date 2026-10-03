-- 20261001075512 — foundation feeds inputs rules decisions outbox
-- Foundation A1, task 1. Five tables the feeds model needs and nothing reads
-- yet: the sources feeding an account and the windows each one has covered,
-- the standing rules a person wrote for one source, the stored judgments of
-- the classifier, and the outbox. Purely additive; no existing table moves.
--
-- `from_at` and `to_at` because `from` and `to` are reserved words. A window's
-- start may be unbounded (`from_at` NULL); its end never is.
--
-- An input belongs to its account and goes with it. The credential and wallet
-- it points at are references, not ownership, so losing either leaves the
-- input standing with the reference cleared.

-- Lock waits are bounded. The runner applies every pending migration in one
-- transaction, so this holds until it commits: a deploy queued behind an open
-- transaction fails with 55P03 and is retried, instead of holding every later
-- query on these tables behind it.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS feed_inputs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  credential_id UUID REFERENCES user_integration_credentials(id) ON DELETE SET NULL,
  wallet_id UUID REFERENCES user_wallets(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CONSTRAINT feed_inputs_status_chk CHECK (status IN ('active', 'disconnected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT feed_inputs_account_source_uq UNIQUE (account_id, source)
);

CREATE TABLE IF NOT EXISTS feed_input_windows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  input_id UUID NOT NULL REFERENCES feed_inputs(id) ON DELETE CASCADE,
  from_at TIMESTAMPTZ,
  to_at TIMESTAMPTZ NOT NULL,
  complete BOOLEAN NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  upload_ref TEXT
);

CREATE INDEX IF NOT EXISTS idx_feed_input_windows_input_to
  ON feed_input_windows (input_id, to_at DESC);

CREATE TABLE IF NOT EXISTS feed_match_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  input_id UUID NOT NULL REFERENCES feed_inputs(id) ON DELETE CASCADE,
  match_field TEXT NOT NULL
    CONSTRAINT feed_match_rules_match_field_chk CHECK (match_field IN ('description', 'counterparty')),
  pattern TEXT NOT NULL,
  destination_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  ledger_kind TEXT
    CONSTRAINT feed_match_rules_ledger_kind_chk CHECK (ledger_kind IN (
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
    )),
  created_by TEXT NOT NULL
    CONSTRAINT feed_match_rules_created_by_chk CHECK (created_by IN ('person', 'proposal-confirmed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT feed_match_rules_names_a_target_chk
    CHECK (destination_account_id IS NOT NULL OR ledger_kind IS NOT NULL),
  CONSTRAINT feed_match_rules_input_field_pattern_uq UNIQUE (input_id, match_field, pattern)
);

CREATE TABLE IF NOT EXISTS judgment_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_key TEXT NOT NULL,
  question_version INTEGER NOT NULL,
  state_hash TEXT NOT NULL,
  model_id TEXT NOT NULL,
  answer TEXT NOT NULL,
  probabilities JSONB NOT NULL,
  applied TEXT NOT NULL
    CONSTRAINT judgment_decisions_applied_chk CHECK (applied IN ('auto', 'proposed', 'confirmed', 'overridden', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT judgment_decisions_one_per_question_state_uq
    UNIQUE (user_id, question_key, question_version, state_hash, model_id)
);

-- `user_id` is nullable: a price event belongs to no user.
CREATE TABLE IF NOT EXISTS outbox_events (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_outbox_events_unpublished
  ON outbox_events (id) WHERE published_at IS NULL;
