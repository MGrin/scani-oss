SET LOCAL lock_timeout = '5s';

ALTER TABLE transaction_categories
  ADD COLUMN budget_root boolean GENERATED ALWAYS AS (parent_id IS NULL) STORED NOT NULL,
  ADD CONSTRAINT transaction_categories_budget_root_uq UNIQUE (id, user_id, budget_root);

CREATE TABLE monthly_category_budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id uuid NOT NULL,
  requires_root boolean NOT NULL DEFAULT true,
  token_id uuid NOT NULL REFERENCES tokens(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  month date NOT NULL,
  "limit" text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT monthly_category_budgets_tuple_uq UNIQUE (user_id, month, category_id, token_id),
  CONSTRAINT monthly_category_budgets_requires_root_check CHECK (requires_root = true),
  CONSTRAINT monthly_category_budgets_root_fk FOREIGN KEY (category_id, user_id, requires_root)
    REFERENCES transaction_categories(id, user_id, budget_root) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT monthly_category_budgets_month_check CHECK (
    month >= date '1900-01-01' AND extract(day FROM month) = 1
    AND month <= date_trunc('month', now() AT TIME ZONE 'UTC')::date
  ),
  CONSTRAINT monthly_category_budgets_limit_check CHECK ("limit" ~ '^[0-9]{1,15}(\.[0-9]{1,18})?$')
);

-- No advisory lock in row triggers: native RI coordinates legacy category writers.
CREATE FUNCTION monthly_category_budgets_token_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM tokens t JOIN token_types tt ON tt.id = t.type_id
    WHERE t.id = NEW.token_id AND tt.code = 'fiat'
    FOR KEY SHARE OF t, tt;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'monthly category budget requires an eligible fiat token'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER monthly_category_budgets_token_check
  BEFORE INSERT OR UPDATE ON monthly_category_budgets
  FOR EACH ROW EXECUTE FUNCTION monthly_category_budgets_token_check();
