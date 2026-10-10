-- 20261009065302 — liability account class and terms
-- SC-1640. An account type is an asset or a liability, and the four liability
-- types are seeded for the pickers to offer once they are active. A
-- liability account's debt is a negative fiat holding; its loan or card terms
-- live in liability_terms, one row per account. Schedule and payoff are
-- computed from these on read and never stored.
--
-- The four types are seeded INACTIVE: until the amount owed can be entered as
-- debt, a user picking "Mortgage" would enter a positive balance that net worth
-- counts as an asset. The change that opens that path activates them.

SET LOCAL lock_timeout = '5s';

ALTER TABLE account_types ADD COLUMN class text NOT NULL DEFAULT 'asset'
  CONSTRAINT account_types_class_chk CHECK (class IN ('asset', 'liability'));

INSERT INTO account_types (code, name, description, is_active, display_order, class, created_at, updated_at) VALUES
  ('loan',            'Loan',            'Personal, auto and student loans',            false, 5, 'liability', now(), now()),
  ('mortgage',        'Mortgage',        'Loans secured on property',                   false, 6, 'liability', now(), now()),
  ('credit_card',     'Credit Card',     'Credit card balances',                        false, 7, 'liability', now(), now()),
  ('other_liability', 'Other Liability', 'Any other money owed',                        false, 8, 'liability', now(), now())
ON CONFLICT (code) DO NOTHING;

CREATE TABLE liability_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CONSTRAINT liability_terms_kind_chk CHECK (kind IN ('loan', 'credit_card', 'other')),
  annual_rate_pct numeric(7, 4),
  term_months integer,
  start_date date,
  original_principal text,
  contracted_payment text,
  credit_limit text,
  minimum_payment text,
  annual_fee text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
