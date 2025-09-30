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
    'Stock',
    'Individual company stocks and equities',
    true,
    2,
    now (),
    now ()
  ),
  (
    'etf',
    'ETF',
    'Exchange-traded funds',
    true,
    3,
    now (),
    now ()
  ),
  (
    'bond',
    'Bond',
    'Government and corporate bonds',
    true,
    4,
    now (),
    now ()
  ),
  (
    'commodity',
    'Commodity',
    'Physical commodities (gold, oil, etc.)',
    true,
    5,
    now (),
    now ()
  );