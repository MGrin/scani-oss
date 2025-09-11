-- Custom SQL migration file, put your code below! --
-- Seed common account types
INSERT INTO
  account_types (
    code,
    name,
    description,
    is_active,
    created_at,
    updated_at
  )
VALUES
  (
    'checking',
    'Checking Account',
    'Everyday spending and transaction accounts',
    true,
    now (),
    now ()
  ),
  (
    'savings',
    'Savings Account',
    'Interest-bearing savings accounts',
    true,
    now (),
    now ()
  ),
  (
    'credit_card',
    'Credit Card',
    'Credit card accounts',
    true,
    now (),
    now ()
  ),
  (
    'investment',
    'Investment Account',
    'General investment and brokerage accounts',
    true,
    now (),
    now ()
  ),
  (
    'retirement',
    'Retirement Account',
    'IRA, 401k, and other retirement accounts',
    true,
    now (),
    now ()
  ),
  (
    'crypto_wallet',
    'Crypto Wallet',
    'Cryptocurrency wallet accounts',
    true,
    now (),
    now ()
  ),
  (
    'loan',
    'Loan Account',
    'Personal loans, mortgages, and debt accounts',
    true,
    now (),
    now ()
  ),
  (
    'other',
    'Other',
    'Other account types',
    true,
    now (),
    now ()
  ) ON CONFLICT (code) DO NOTHING;