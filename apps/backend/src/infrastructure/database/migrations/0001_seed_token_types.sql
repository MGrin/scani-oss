-- Custom SQL migration file, put your code below! --
-- Custom SQL migration file, put your code below! --
-- Seed common token types
INSERT INTO
  token_types (
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
    'fiat',
    'Fiat Currency',
    'Government-issued currencies (USD, EUR, etc.)',
    true,
    0,
    now (),
    now ()
  ),
  (
    'crypto',
    'Cryptocurrency',
    'Digital cryptocurrencies (BTC, ETH, etc.)',
    true,
    1,
    now (),
    now ()
  ),
  (
    'stock',
    'Stock / ETF / Equity / Commodity',
    'Publicly traded stocks and equities, including ETFs, Commodities, etc.',
    true,
    2,
    now (),
    now ()
  ),
  (
    'private-company',
    'Private Company',
    'Private Company, not having a public price available',
    true,
    3,
    now (),
    now ()
  ),
  (
    'other',
    'Other',
    'Other type of asset',
    true,
    4,
    now (),
    now ()
  );