-- Custom SQL migration file, put your code below! --
-- Seed common account types
INSERT INTO
  account_types (
    code,
    name,
    description,
    is_active,
    display_order,
    created_at,
    updated_at
  )
VALUES
  (
    'checking',
    'Checking Account',
    'Everyday spending and transaction accounts',
    true,
    0,
    now (),
    now ()
  ),
  (
    'savings',
    'Savings Account',
    'Interest-bearing savings accounts',
    true,
    1,
    now (),
    now ()
  ),
  (
    'credit_card',
    'Credit Card',
    'Credit card accounts',
    true,
    3,
    now (),
    now ()
  ),
  (
    'investment',
    'Investment Account',
    'General investment and brokerage accounts',
    true,
    2,
    now (),
    now ()
  ),
  (
    'crypto_wallet',
    'Crypto Wallet',
    'Cryptocurrency wallet accounts',
    true,
    4,
    now (),
    now ()
  ),
  (
    'loan',
    'Loan Account',
    'Personal loans, mortgages, and debt accounts',
    true,
    5,
    now (),
    now ()
  ),
  (
    'other',
    'Other',
    'Other account types',
    true,
    6,
    now (),
    now ()
  ) ON CONFLICT (code) DO NOTHING;