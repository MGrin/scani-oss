-- Custom SQL migration file, put your code below! --
-- Seed common institution types
INSERT INTO
  institution_types (
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
    'bank',
    'Bank',
    'Traditional banks and credit unions',
    true,
    0,
    now (),
    now ()
  ),
  (
    'broker',
    'Brokerage',
    'Investment brokerages and trading platforms',
    true,
    3,
    now (),
    now ()
  ),
  (
    'crypto_wallet',
    'Crypto Wallet',
    'Cryptocurrency wallets and custodial services',
    true,
    1,
    now (),
    now ()
  ),
  (
    'crypto_exchange',
    'Crypto Exchange',
    'Cryptocurrency exchanges and trading platforms',
    true,
    2,
    now (),
    now ()
  ),
  (
    'investment_fund',
    'Investment Fund',
    'Mutual funds, ETFs, and other pooled investment vehicles',
    true,
    4,
    now (),
    now ()
  ),
  (
    'private_equity',
    'Private Equity',
    'Private equity and venture capital firms',
    true,
    6,
    now (),
    now ()
  ),
  (
    'real_estate',
    'Real Estate',
    'Real estate investment and management firms',
    true,
    5,
    now (),
    now ()
  ),
  (
    'other',
    'Other',
    'Other financial institutions',
    true,
    7,
    now (),
    now ()
  ) ON CONFLICT (code) DO NOTHING;