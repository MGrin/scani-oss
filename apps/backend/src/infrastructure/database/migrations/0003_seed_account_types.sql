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
    'investment',
    'Investment Account',
    'General investment and brokerage accounts',
    true,
    2,
    now (),
    now ()
  ),
  (
    'crypto',
    'Cryptocurrency',
    'Cryptocurrency accounts',
    true,
    3,
    now (),
    now ()
  ),
  (
    'other',
    'Other',
    'Other account types',
    true,
    4,
    now (),
    now ()
  );