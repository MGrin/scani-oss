-- Seed enum-table rows: token_types, institution_types, account_types.
-- These are "dynamic enums" (DB rows, not SQL enums) referenced by the
-- application's domain code; inserts are idempotent via ON CONFLICT.

INSERT INTO token_types (code, name, description, is_active, display_order, created_at, updated_at) VALUES
  ('fiat',            'Fiat Currency',                   'Government-issued currencies (USD, EUR, etc.)',                           true, 0, now(), now()),
  ('crypto',          'Cryptocurrency',                  'Digital cryptocurrencies (BTC, ETH, etc.)',                               true, 1, now(), now()),
  ('stock',           'Stock / ETF / Equity / Commodity','Publicly traded stocks and equities, including ETFs, Commodities, etc.', true, 2, now(), now()),
  ('private-company', 'Private Company',                 'Private Company, not having a public price available',                   true, 3, now(), now()),
  ('other',           'Other',                           'Other type of asset',                                                     true, 4, now(), now())
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

INSERT INTO institution_types (code, name, description, is_active, display_order, created_at, updated_at) VALUES
  ('bank',             'Bank',             'Traditional banks and credit unions',                                                        true, 0, now(), now()),
  ('broker',           'Brokerage',        'Investment brokerages and trading platforms',                                                true, 3, now(), now()),
  ('crypto_wallet',    'Crypto Wallet',    'Cryptocurrency wallets and custodial services',                                              true, 1, now(), now()),
  ('crypto_exchange',  'Crypto Exchange',  'Cryptocurrency exchanges and trading platforms',                                             true, 2, now(), now()),
  ('investment_fund',  'Investment Fund',  'Any type of investement fund you keep your money in',                                        true, 4, now(), now()),
  ('private_equity',   'Private Equity',   'Institution focused on private equity investments. Example: Carta, EquityZen, Ledgy',        true, 6, now(), now()),
  ('real_estate',      'Real Estate',      'Real estate investment and management firms',                                                true, 5, now(), now()),
  ('other',            'Other',            'Other financial institutions',                                                               true, 7, now(), now())
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

INSERT INTO account_types (code, name, description, is_active, display_order, created_at, updated_at) VALUES
  ('checking',   'Checking Account',    'Everyday spending and transaction accounts', true, 0, now(), now()),
  ('savings',    'Savings Account',     'Interest-bearing savings accounts',          true, 1, now(), now()),
  ('investment', 'Investment Account',  'General investment and brokerage accounts',  true, 2, now(), now()),
  ('crypto',     'Cryptocurrency',      'Cryptocurrency accounts',                    true, 3, now(), now()),
  ('other',      'Other',               'Other account types',                        true, 4, now(), now())
ON CONFLICT (code) DO NOTHING;
