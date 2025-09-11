-- Custom SQL migration file, put your code below! --
-- Seed common token types
INSERT INTO
  token_types (
    code,
    name,
    description,
    is_active,
    created_at,
    updated_at
  )
VALUES
  (
    'fiat',
    'Fiat Currency',
    'Government-issued currencies (USD, EUR, etc.)',
    true,
    now (),
    now ()
  ),
  (
    'crypto',
    'Cryptocurrency',
    'Digital cryptocurrencies (BTC, ETH, etc.)',
    true,
    now (),
    now ()
  ),
  (
    'stock',
    'Stock',
    'Individual company stocks and equities',
    true,
    now (),
    now ()
  ),
  (
    'etf',
    'ETF',
    'Exchange-traded funds',
    true,
    now (),
    now ()
  ),
  (
    'bond',
    'Bond',
    'Government and corporate bonds',
    true,
    now (),
    now ()
  ),
  (
    'commodity',
    'Commodity',
    'Physical commodities (gold, oil, etc.)',
    true,
    now (),
    now ()
  );