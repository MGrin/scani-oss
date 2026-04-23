-- Seed / enable institutions for the second batch of API-key integrations:
-- regional crypto (BTC Markets, Bitfinex, Bitpanda, bitFlyer, Coincheck,
-- bitbank), brokers (Alpaca, T-Bank/Tinkoff, Tiger Brokers, Zerodha),
-- and neobanks (Mercury, Brex).

DO $$
DECLARE
    v_bank_type_id uuid;
    v_broker_type_id uuid;
    v_crypto_exchange_type_id uuid;
BEGIN
    SELECT id INTO v_bank_type_id FROM institution_types WHERE code = 'bank';
    SELECT id INTO v_broker_type_id FROM institution_types WHERE code = 'broker';
    SELECT id INTO v_crypto_exchange_type_id FROM institution_types WHERE code = 'crypto_exchange';

    -- New crypto exchanges.
    INSERT INTO institutions (name, type_id, description, website, logo_url, is_active, created_at, updated_at) VALUES
      ('BTC Markets', v_crypto_exchange_type_id, 'Australian cryptocurrency exchange founded in 2013', 'https://www.btcmarkets.net', NULL, true, now(), now()),
      ('Bitpanda', v_crypto_exchange_type_id, 'European cryptocurrency broker with crypto and fiat wallets', 'https://www.bitpanda.com', NULL, true, now(), now()),
      ('bitbank', v_crypto_exchange_type_id, 'Japanese cryptocurrency exchange focused on algorithmic trading', 'https://bitbank.cc', NULL, true, now(), now())
    ON CONFLICT (website) DO NOTHING;

    -- New brokers.
    INSERT INTO institutions (name, type_id, description, website, logo_url, is_active, created_at, updated_at) VALUES
      ('Alpaca', v_broker_type_id, 'American developer-first brokerage for stocks, options and crypto', 'https://alpaca.markets', NULL, true, now(), now()),
      ('T-Bank (Tinkoff)', v_broker_type_id, 'Russian online broker — T-Invest platform. Sanctions-sensitive; enablement gated per jurisdiction.', 'https://www.tbank.ru/invest/', NULL, true, now(), now()),
      ('Tiger Brokers', v_broker_type_id, 'Singapore / Hong Kong online broker offering US, HK, SG and AU equities', 'https://www.tigerbrokers.com', NULL, true, now(), now()),
      ('Zerodha', v_broker_type_id, 'Indian discount broker, largest by active clients', 'https://zerodha.com', NULL, true, now(), now())
    ON CONFLICT (website) DO NOTHING;

    -- New banks.
    INSERT INTO institutions (name, type_id, description, website, logo_url, is_active, created_at, updated_at) VALUES
      ('Mercury', v_bank_type_id, 'American neobank serving startups with business banking', 'https://mercury.com', NULL, true, now(), now()),
      ('Brex', v_bank_type_id, 'American corporate financial services company offering cash accounts and cards', 'https://www.brex.com', NULL, true, now(), now())
    ON CONFLICT (website) DO NOTHING;

    -- Flip has_integration on everything in this batch, including
    -- Bitfinex / bitFlyer / Coincheck which were already seeded by
    -- 0003_seed_institutions.sql.
    UPDATE institutions SET has_integration = true
     WHERE website IN (
       'https://www.btcmarkets.net',
       'https://www.bitfinex.com',
       'https://www.bitpanda.com',
       'https://bitflyer.com',
       'https://www.bitflyer.com',
       'https://coincheck.com',
       'https://www.coincheck.com',
       'https://bitbank.cc',
       'https://alpaca.markets',
       'https://www.tbank.ru/invest/',
       'https://www.tigerbrokers.com',
       'https://zerodha.com',
       'https://mercury.com',
       'https://www.brex.com'
     );
END $$;
