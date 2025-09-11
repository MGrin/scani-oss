-- Custom SQL migration file, put your code below! --
-- Seed common institution types
INSERT INTO
  institution_types (
    code,
    name,
    description,
    is_active,
    created_at,
    updated_at
  )
VALUES
  (
    'bank',
    'Bank',
    'Traditional banks and credit unions',
    true,
    now (),
    now ()
  ),
  (
    'broker',
    'Brokerage',
    'Investment brokerages and trading platforms',
    true,
    now (),
    now ()
  ),
  (
    'crypto_wallet',
    'Crypto Wallet',
    'Cryptocurrency wallets and custodial services',
    true,
    now (),
    now ()
  ),
  (
    'crypto_exchange',
    'Crypto Exchange',
    'Cryptocurrency exchanges and trading platforms',
    true,
    now (),
    now ()
  ),
  (
    'investment_fund',
    'Investment Fund',
    'Mutual funds, ETFs, and other pooled investment vehicles',
    true,
    now (),
    now ()
  ),
  (
    'private_equity',
    'Private Equity',
    'Private equity and venture capital firms',
    true,
    now (),
    now ()
  ),
  (
    'real_estate',
    'Real Estate',
    'Real estate investment and management firms',
    true,
    now (),
    now ()
  ),
  (
    'other',
    'Other',
    'Other financial institutions',
    true,
    now (),
    now ()
  ) ON CONFLICT (code) DO NOTHING;