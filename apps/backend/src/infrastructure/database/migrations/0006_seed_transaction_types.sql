-- Migration: Seed transaction types
-- Created at: 2024-09-13
-- Description: Add default transaction types (deposit, withdrawal, transfer)
INSERT INTO
  "transaction_types" (
    "id",
    "code",
    "name",
    "description",
    "display_order",
    "is_active",
    "created_at",
    "updated_at"
  )
VALUES
  (
    gen_random_uuid (),
    'deposit',
    'Deposit',
    'Money or assets added to an account or position',
    1,
    true,
    now (),
    now ()
  ),
  (
    gen_random_uuid (),
    'withdrawal',
    'Withdrawal',
    'Money or assets removed from an account or position',
    2,
    true,
    now (),
    now ()
  ),
  (
    gen_random_uuid (),
    'transfer',
    'Transfer',
    'Movement of assets between accounts or positions',
    3,
    true,
    now (),
    now ()
  ),
  (
    gen_random_uuid (),
    'buy',
    'Buy',
    'Purchase of an asset or security',
    4,
    true,
    now (),
    now ()
  ),
  (
    gen_random_uuid (),
    'sell',
    'Sell',
    'Sale of an asset or security',
    5,
    true,
    now (),
    now ()
  ),
  (
    gen_random_uuid (),
    'dividend',
    'Dividend',
    'Distribution of earnings to shareholders',
    6,
    true,
    now (),
    now ()
  ),
  (
    gen_random_uuid (),
    'interest',
    'Interest',
    'Interest earned on deposits or paid on loans',
    7,
    true,
    now (),
    now ()
  ),
  (
    gen_random_uuid (),
    'fee',
    'Fee',
    'Service charges or transaction fees',
    8,
    true,
    now (),
    now ()
  ),
  (
    gen_random_uuid (),
    'split',
    'Stock Split',
    'Division of existing shares into multiple shares',
    9,
    true,
    now (),
    now ()
  ),
  (
    gen_random_uuid (),
    'merge',
    'Stock Merge',
    'Combination of multiple shares into fewer shares',
    10,
    true,
    now (),
    now ()
  ) ON CONFLICT (code) DO NOTHING;