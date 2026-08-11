CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vendor_id uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
  direction text NOT NULL,
  kind text NOT NULL,
  expected_amount text,
  currency_token_id uuid NOT NULL REFERENCES tokens(id) ON DELETE RESTRICT,
  interval_unit text NOT NULL,
  interval_count integer NOT NULL,
  anchor_date date NOT NULL,
  status text NOT NULL DEFAULT 'active',
  end_date date,
  account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  origin text NOT NULL DEFAULT 'manual',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_direction_check CHECK (direction IN ('outflow', 'inflow')),
  CONSTRAINT payments_kind_check CHECK (kind IN ('fixed', 'variable')),
  CONSTRAINT payments_interval_unit_check CHECK (interval_unit IN ('week', 'month', 'quarter', 'year')),
  CONSTRAINT payments_interval_count_check CHECK (interval_count > 0),
  CONSTRAINT payments_status_check CHECK (status IN ('active', 'paused', 'ended')),
  -- 'detected' kept even though nothing writes it yet: detection was
  -- dropped from this iteration, and leaving the value out would mean a
  -- migration to re-add it if it comes back.
  CONSTRAINT payments_origin_check CHECK (origin IN ('manual', 'detected', 'document'))
);

CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments (user_id);
CREATE INDEX IF NOT EXISTS idx_payments_user_status ON payments (user_id, status);

CREATE TABLE IF NOT EXISTS payment_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  due_date date NOT NULL,
  expected_amount text,
  status text NOT NULL DEFAULT 'scheduled',
  -- No FK: extractions live outside the DB-backed job result today
  -- (see user_jobs.result jsonb); this is a loose reference until an
  -- extractions table exists.
  matched_transaction_id uuid REFERENCES holding_transactions(id) ON DELETE SET NULL,
  matched_extraction_id uuid,
  actual_amount text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_occurrences_status_check CHECK (status IN ('scheduled', 'matched', 'missed', 'skipped')),
  CONSTRAINT payment_occurrences_payment_due_date_unique UNIQUE (payment_id, due_date)
);

CREATE INDEX IF NOT EXISTS idx_payment_occurrences_due_date ON payment_occurrences (due_date);
CREATE INDEX IF NOT EXISTS idx_payment_occurrences_status ON payment_occurrences (status);
