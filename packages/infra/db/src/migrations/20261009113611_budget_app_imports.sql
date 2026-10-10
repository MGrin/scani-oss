-- 20261009113611 — budget app imports
-- SC-1649. One row per upload of a YNAB or Actual register, and one per ledger
-- row it inserted, so the upload can be undone without touching rows another
-- upload or the person wrote. The foreign keys on users and holding_transactions
-- take locks on both, so the wait is bounded.

SET LOCAL lock_timeout = '5s';

CREATE TABLE budget_app_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app text NOT NULL,
  upload_ref text NOT NULL,
  created_account_ids uuid[] NOT NULL DEFAULT '{}',
  summary jsonb NOT NULL,
  undone_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_budget_app_imports_user_created ON budget_app_imports (user_id, created_at DESC);

CREATE TABLE budget_app_import_entries (
  import_id uuid NOT NULL REFERENCES budget_app_imports(id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL REFERENCES holding_transactions(id) ON DELETE CASCADE,
  PRIMARY KEY (import_id, transaction_id)
);

CREATE INDEX idx_budget_app_import_entries_transaction ON budget_app_import_entries (transaction_id);
