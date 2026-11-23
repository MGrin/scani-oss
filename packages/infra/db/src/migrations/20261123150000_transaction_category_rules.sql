SET LOCAL lock_timeout = '3s';

CREATE TABLE transaction_category_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  category_id uuid NOT NULL,
  payee_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transaction_category_rules_scope_uq UNIQUE (user_id, account_id, payee_key),
  CONSTRAINT transaction_category_rules_category_fk FOREIGN KEY (category_id, user_id)
    REFERENCES transaction_categories(id, user_id) ON DELETE RESTRICT
);
CREATE INDEX transaction_category_rules_category_idx ON transaction_category_rules(category_id, user_id);

CREATE TABLE transaction_category_rule_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'applied', 'undone')),
  projection_version integer NOT NULL DEFAULT 1,
  scope jsonb NOT NULL,
  snapshot jsonb NOT NULL,
  candidate_ids jsonb NOT NULL CHECK (jsonb_array_length(candidate_ids) <= 500),
  changed_ids jsonb NOT NULL CHECK (jsonb_array_length(changed_ids) <= 500),
  candidates jsonb NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  applied_at timestamptz,
  undone_at timestamptz
);
CREATE INDEX transaction_category_rule_runs_owner_idx ON transaction_category_rule_runs(user_id, applied_at, id);

ALTER TABLE holding_transactions DROP CONSTRAINT holding_tx_category_set_by_check;
ALTER TABLE holding_transactions ADD CONSTRAINT holding_tx_category_set_by_check CHECK (
  category_set_by IN ('person', 'import', 'rule', 'ai', 'kind', 'custom_rule') AND category_id IS NOT NULL
  OR category_set_by = 'cleared' AND category_id IS NULL
  OR category_set_by IS NULL AND category_id IS NULL
) NOT VALID;
ALTER TABLE holding_transactions VALIDATE CONSTRAINT holding_tx_category_set_by_check;
