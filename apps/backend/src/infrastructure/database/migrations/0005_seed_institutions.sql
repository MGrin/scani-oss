-- Custom SQL migration file, put your code below! --
-- Seed global financial institutions
-- This migration inserts major banks, brokers, crypto exchanges, wallets, and other financial institutions worldwide

DO $$
DECLARE
  bank_type_id UUID;
  broker_type_id UUID;
  crypto_wallet_type_id UUID;
  crypto_exchange_type_id UUID;
  investment_fund_type_id UUID;
  private_equity_type_id UUID;
  real_estate_type_id UUID;
  other_type_id UUID;
BEGIN
  -- Get institution type IDs
  SELECT id INTO bank_type_id FROM institution_types WHERE code = 'bank';
  SELECT id INTO broker_type_id FROM institution_types WHERE code = 'broker';
  SELECT id INTO crypto_wallet_type_id FROM institution_types WHERE code = 'crypto_wallet';
  SELECT id INTO crypto_exchange_type_id FROM institution_types WHERE code = 'crypto_exchange';
  SELECT id INTO investment_fund_type_id FROM institution_types WHERE code = 'investment_fund';
  SELECT id INTO private_equity_type_id FROM institution_types WHERE code = 'private_equity';
  SELECT id INTO real_estate_type_id FROM institution_types WHERE code = 'real_estate';
  SELECT id INTO other_type_id FROM institution_types WHERE code = 'other';

  -- Insert institutions
  INSERT INTO institutions (
    name,
    type_id,
    description,
    website,
    logo_url,
    is_active,
    created_at,
    updated_at
  )
  VALUES
    -- ========================================
    -- BANKS - NORTH AMERICA
    -- ========================================
    ('JPMorgan Chase', bank_type_id, 'Largest bank in the United States by assets', 'https://www.jpmorganchase.com', NULL, true, now(), now()),
    ('Bank of America', bank_type_id, 'Major American multinational investment bank and financial services holding company', 'https://www.bankofamerica.com', NULL, true, now(), now()),
    ('Citigroup', bank_type_id, 'Global financial services corporation', 'https://www.citigroup.com', NULL, true, now(), now()),
    ('Wells Fargo', bank_type_id, 'American multinational financial services company', 'https://www.wellsfargo.com', NULL, true, now(), now()),
    ('Goldman Sachs', bank_type_id, 'Leading global investment banking, securities and investment management firm', 'https://www.goldmansachs.com', NULL, true, now(), now()),
    ('Morgan Stanley', bank_type_id, 'American multinational investment bank and financial services company', 'https://www.morganstanley.com', NULL, true, now(), now()),
    ('U.S. Bancorp', bank_type_id, 'American bank holding company based in Minneapolis', 'https://www.usbank.com', NULL, true, now(), now()),
    ('Capital One', bank_type_id, 'American bank holding company specializing in credit cards, auto loans, banking, and savings accounts', 'https://www.capitalone.com', NULL, true, now(), now()),
    ('PNC Financial Services', bank_type_id, 'Major bank in the United States', 'https://www.pnc.com', NULL, true, now(), now()),
    ('Truist Financial', bank_type_id, 'American bank holding company formed by the merger of BB&T and SunTrust', 'https://www.truist.com', NULL, true, now(), now()),
    ('Charles Schwab', bank_type_id, 'American multinational financial services corporation', 'https://www.schwab.com', NULL, true, now(), now()),
    ('BNY Mellon', bank_type_id, 'American investment banking services holding company', 'https://www.bnymellon.com', NULL, true, now(), now()),

    -- BANKS - CANADA
    ('Royal Bank of Canada', bank_type_id, 'Largest bank in Canada by market capitalization', 'https://www.rbc.com', NULL, true, now(), now()),
    ('Toronto-Dominion Bank', bank_type_id, 'Canadian multinational banking and financial services corporation', 'https://www.td.com', NULL, true, now(), now()),
    ('Bank of Nova Scotia', bank_type_id, 'Canadian multinational banking and financial services company', 'https://www.scotiabank.com', NULL, true, now(), now()),
    ('Bank of Montreal', bank_type_id, 'Canadian multinational investment bank and financial services company', 'https://www.bmo.com', NULL, true, now(), now()),
    ('Canadian Imperial Bank of Commerce', bank_type_id, 'Canadian banking and financial services corporation', 'https://www.cibc.com', NULL, true, now(), now()),
    ('National Bank of Canada', bank_type_id, 'Sixth largest commercial bank in Canada', 'https://www.nbc.ca', NULL, true, now(), now()),

    -- ========================================
    -- BANKS - EUROPE
    -- ========================================
    ('HSBC', bank_type_id, 'British multinational universal bank and financial services holding company', 'https://www.hsbc.com', NULL, true, now(), now()),
    ('BNP Paribas', bank_type_id, 'French international banking group', 'https://www.bnpparibas.com', NULL, true, now(), now()),
    ('Crédit Agricole', bank_type_id, 'French network of cooperative and mutual banks', 'https://www.credit-agricole.com', NULL, true, now(), now()),
    ('Banco Santander', bank_type_id, 'Spanish multinational financial services company', 'https://www.santander.com', NULL, true, now(), now()),
    ('Barclays', bank_type_id, 'British multinational universal bank', 'https://www.barclays.com', NULL, true, now(), now()),
    ('Société Générale', bank_type_id, 'French multinational investment bank and financial services company', 'https://www.societegenerale.com', NULL, true, now(), now()),
    ('UBS', bank_type_id, 'Swiss multinational investment bank and financial services company', 'https://www.ubs.com', NULL, true, now(), now()),
    ('Deutsche Bank', bank_type_id, 'German multinational investment bank and financial services company', 'https://www.db.com', NULL, true, now(), now()),
    ('Lloyds Banking Group', bank_type_id, 'British financial institution formed through the acquisition of HBOS', 'https://www.lloydsbankinggroup.com', NULL, true, now(), now()),
    ('ING Group', bank_type_id, 'Dutch multinational banking and financial services corporation', 'https://www.ing.com', NULL, true, now(), now()),
    ('Intesa Sanpaolo', bank_type_id, 'Italian banking group resulting from the merger of Banca Intesa and Sanpaolo IMI', 'https://www.intesasanpaolo.com', NULL, true, now(), now()),
    ('NatWest Group', bank_type_id, 'British banking and insurance holding company', 'https://www.natwestgroup.com', NULL, true, now(), now()),
    ('UniCredit', bank_type_id, 'Italian global banking and financial services company', 'https://www.unicredit.eu', NULL, true, now(), now()),
    ('Standard Chartered', bank_type_id, 'British multinational banking and financial services company', 'https://www.sc.com', NULL, true, now(), now()),
    ('Banco Bilbao Vizcaya Argentaria', bank_type_id, 'Spanish multinational financial services company', 'https://www.bbva.com', NULL, true, now(), now()),
    ('DZ Bank', bank_type_id, 'German central institution for cooperative banks', 'https://www.dzbank.com', NULL, true, now(), now()),
    ('Rabobank', bank_type_id, 'Dutch multinational banking and financial services company', 'https://www.rabobank.com', NULL, true, now(), now()),
    ('CaixaBank', bank_type_id, 'Spanish bank based in Valencia', 'https://www.caixabank.com', NULL, true, now(), now()),
    ('Nordea', bank_type_id, 'Nordic financial services group', 'https://www.nordea.com', NULL, true, now(), now()),
    ('Commerzbank', bank_type_id, 'German global banking and financial services company', 'https://www.commerzbank.com', NULL, true, now(), now()),
    ('Danske Bank', bank_type_id, 'Danish bank operating as a universal bank', 'https://www.danskebank.com', NULL, true, now(), now()),
    ('ABN AMRO', bank_type_id, 'Dutch bank with headquarters in Amsterdam', 'https://www.abnamro.com', NULL, true, now(), now()),
    ('KBC Group', bank_type_id, 'Belgian universal multi-channel bank-insurer', 'https://www.kbc.com', NULL, true, now(), now()),
    ('Erste Group', bank_type_id, 'Austrian banking group headquartered in Vienna', 'https://www.erstegroup.com', NULL, true, now(), now()),
    ('SEB Group', bank_type_id, 'Swedish financial services group for corporate customers, institutions and private individuals', 'https://www.sebgroup.com', NULL, true, now(), now()),
    ('Handelsbanken', bank_type_id, 'Swedish bank providing banking services and financial solutions', 'https://www.handelsbanken.com', NULL, true, now(), now()),
    ('DNB', bank_type_id, 'Norwegian financial services group', 'https://www.dnb.no', NULL, true, now(), now()),
    ('Raiffeisen Bank International', bank_type_id, 'Austrian banking group headquartered in Vienna', 'https://www.rbinternational.com', NULL, true, now(), now()),
    ('Credit Suisse', bank_type_id, 'Swiss investment bank and financial services firm (now part of UBS)', 'https://www.credit-suisse.com', NULL, true, now(), now()),

    -- ========================================
    -- BANKS - ASIA
    -- ========================================
    ('Industrial and Commercial Bank of China', bank_type_id, 'Largest bank in the world by total assets', 'https://www.icbc.com.cn', NULL, true, now(), now()),
    ('China Construction Bank', bank_type_id, 'One of the largest banks in China', 'https://www.ccb.com', NULL, true, now(), now()),
    ('Agricultural Bank of China', bank_type_id, 'One of the Big Four banks in China', 'https://www.abchina.com', NULL, true, now(), now()),
    ('Bank of China', bank_type_id, 'Chinese state-owned commercial bank', 'https://www.boc.cn', NULL, true, now(), now()),
    ('Mitsubishi UFJ Financial Group', bank_type_id, 'Japanese bank holding and financial services company', 'https://www.mufg.jp', NULL, true, now(), now()),
    ('SMBC Group', bank_type_id, 'Japanese financial services company', 'https://www.smbc.co.jp', NULL, true, now(), now()),
    ('Mizuho Financial Group', bank_type_id, 'Japanese bank holding company', 'https://www.mizuhogroup.com', NULL, true, now(), now()),
    ('Postal Savings Bank of China', bank_type_id, 'Chinese commercial retail bank', 'https://www.psbc.com', NULL, true, now(), now()),
    ('Bank of Communications', bank_type_id, 'One of the largest banks in China', 'https://www.bankcomm.com', NULL, true, now(), now()),
    ('China Merchants Bank', bank_type_id, 'Chinese commercial bank', 'https://www.cmbchina.com', NULL, true, now(), now()),
    ('State Bank of India', bank_type_id, 'Indian multinational public sector bank and financial services company', 'https://www.sbi.co.in', NULL, true, now(), now()),
    ('HDFC Bank', bank_type_id, 'Indian banking and financial services company', 'https://www.hdfcbank.com', NULL, true, now(), now()),
    ('DBS Group', bank_type_id, 'Singaporean multinational banking and financial services corporation', 'https://www.dbs.com', NULL, true, now(), now()),
    ('Oversea-Chinese Banking Corporation', bank_type_id, 'Singaporean bank with regional operations', 'https://www.ocbc.com', NULL, true, now(), now()),
    ('United Overseas Bank', bank_type_id, 'Singaporean multinational banking corporation', 'https://www.uob.com.sg', NULL, true, now(), now()),
    ('KB Financial Group', bank_type_id, 'South Korean financial services company', 'https://www.kbfg.com', NULL, true, now(), now()),
    ('Shinhan Financial Group', bank_type_id, 'South Korean financial services company', 'https://www.shinhangroup.com', NULL, true, now(), now()),
    ('Hana Financial Group', bank_type_id, 'South Korean financial services company', 'https://www.hanafn.com', NULL, true, now(), now()),
    ('Woori Financial Group', bank_type_id, 'South Korean financial services company', 'https://www.woorifg.com', NULL, true, now(), now()),
    ('Industrial Bank of Korea', bank_type_id, 'South Korean commercial bank', 'https://www.ibk.co.kr', NULL, true, now(), now()),

    -- ========================================
    -- BANKS - OCEANIA
    -- ========================================
    ('Commonwealth Bank', bank_type_id, 'Australian multinational bank', 'https://www.commbank.com.au', NULL, true, now(), now()),
    ('Westpac', bank_type_id, 'Australian bank and financial services provider', 'https://www.westpac.com.au', NULL, true, now(), now()),
    ('ANZ Group', bank_type_id, 'Australian multinational banking and financial services company', 'https://www.anz.com.au', NULL, true, now(), now()),
    ('National Australia Bank', bank_type_id, 'One of the four largest financial institutions in Australia', 'https://www.nab.com.au', NULL, true, now(), now()),

    -- ========================================
    -- BANKS - LATIN AMERICA
    -- ========================================
    ('Itaú Unibanco', bank_type_id, 'Brazilian financial services company', 'https://www.itau.com.br', NULL, true, now(), now()),
    ('Banco do Brasil', bank_type_id, 'Brazilian financial services company', 'https://www.bb.com.br', NULL, true, now(), now()),
    ('Banco Bradesco', bank_type_id, 'Brazilian financial services company', 'https://www.bradesco.com.br', NULL, true, now(), now()),

    -- ========================================
    -- BANKS - MIDDLE EAST & AFRICA
    -- ========================================
    ('Qatar National Bank', bank_type_id, 'Qatari multinational commercial bank', 'https://www.qnb.com', NULL, true, now(), now()),
    ('First Abu Dhabi Bank', bank_type_id, 'Largest bank in the United Arab Emirates', 'https://www.bankfab.com', NULL, true, now(), now()),
    ('Emirates NBD', bank_type_id, 'Banking group in the Middle East', 'https://www.emiratesnbd.com', NULL, true, now(), now()),
    ('Sberbank', bank_type_id, 'Russian banking and financial services company', 'https://www.sberbank.com', NULL, true, now(), now()),
    ('Standard Bank', bank_type_id, 'South African banking and financial services group', 'https://www.standardbank.com', NULL, true, now(), now()),

    -- ========================================
    -- BROKERS - GLOBAL
    -- ========================================
    ('Interactive Brokers', broker_type_id, 'American multinational brokerage firm offering direct access to stocks, options, futures, forex, and bonds', 'https://www.interactivebrokers.com', NULL, true, now(), now()),
    ('Charles Schwab', broker_type_id, 'American multinational financial services corporation providing brokerage and banking services', 'https://www.schwab.com', NULL, true, now(), now()),
    ('Fidelity Investments', broker_type_id, 'American multinational financial services corporation offering brokerage services', 'https://www.fidelity.com', NULL, true, now(), now()),
    ('TD Ameritrade', broker_type_id, 'American online broker (now part of Charles Schwab)', 'https://www.tdameritrade.com', NULL, true, now(), now()),
    ('E*TRADE', broker_type_id, 'American financial services company (now part of Morgan Stanley)', 'https://www.etrade.com', NULL, true, now(), now()),
    ('Robinhood', broker_type_id, 'American financial services company known for commission-free trades', 'https://www.robinhood.com', NULL, true, now(), now()),
    ('Vanguard', broker_type_id, 'American investment management company offering brokerage services', 'https://www.vanguard.com', NULL, true, now(), now()),
    ('Merrill Edge', broker_type_id, 'Electronic trading platform and investment advisory service offered by Bank of America', 'https://www.merrilledge.com', NULL, true, now(), now()),
    ('Webull', broker_type_id, 'Chinese-American electronic trading platform offering commission-free trading', 'https://www.webull.com', NULL, true, now(), now()),
    ('Saxo Bank', broker_type_id, 'Danish investment bank specializing in online trading and investment', 'https://www.home.saxo', NULL, true, now(), now()),
    ('IG Group', broker_type_id, 'British multinational online trading company', 'https://www.ig.com', NULL, true, now(), now()),
    ('Trading 212', broker_type_id, 'UK and Bulgarian fintech company offering commission-free trading', 'https://www.trading212.com', NULL, true, now(), now()),
    ('Degiro', broker_type_id, 'Dutch online discount broker', 'https://www.degiro.com', NULL, true, now(), now()),
    ('eToro', broker_type_id, 'Israeli social trading and multi-asset brokerage company', 'https://www.etoro.com', NULL, true, now(), now()),
    ('Plus500', broker_type_id, 'Israeli online trading company offering CFDs', 'https://www.plus500.com', NULL, true, now(), now()),
    ('XTB', broker_type_id, 'Polish brokerage house offering forex and CFD trading', 'https://www.xtb.com', NULL, true, now(), now()),
    ('Questrade', broker_type_id, 'Canadian online discount brokerage', 'https://www.questrade.com', NULL, true, now(), now()),
    ('Wealthsimple', broker_type_id, 'Canadian online investment management service', 'https://www.wealthsimple.com', NULL, true, now(), now()),
    ('CMC Markets', broker_type_id, 'UK-based financial services company offering online trading', 'https://www.cmcmarkets.com', NULL, true, now(), now()),
    ('OANDA', broker_type_id, 'Canadian corporation providing Internet-based forex trading and currency information services', 'https://www.oanda.com', NULL, true, now(), now()),
    ('Ally Invest', broker_type_id, 'American online brokerage subsidiary of Ally Financial', 'https://www.ally.com/invest', NULL, true, now(), now()),
    ('Tastytrade', broker_type_id, 'American financial network and online brokerage for options traders', 'https://www.tastytrade.com', NULL, true, now(), now()),
    ('SoFi', broker_type_id, 'American personal finance company offering brokerage services', 'https://www.sofi.com', NULL, true, now(), now()),
    ('Moomoo', broker_type_id, 'Investment and trading platform developed by Futu Holdings', 'https://www.moomoo.com', NULL, true, now(), now()),
    ('Public', broker_type_id, 'American social investing platform', 'https://www.public.com', NULL, true, now(), now()),

    -- ========================================
    -- CRYPTO EXCHANGES - GLOBAL
    -- ========================================
    ('Binance', crypto_exchange_type_id, 'Global cryptocurrency exchange providing platform for trading various cryptocurrencies', 'https://www.binance.com', NULL, true, now(), now()),
    ('Coinbase', crypto_exchange_type_id, 'American publicly traded cryptocurrency exchange platform', 'https://www.coinbase.com', NULL, true, now(), now()),
    ('Kraken', crypto_exchange_type_id, 'United States-based cryptocurrency exchange', 'https://www.kraken.com', NULL, true, now(), now()),
    ('Bitfinex', crypto_exchange_type_id, 'Cryptocurrency exchange owned and operated by iFinex', 'https://www.bitfinex.com', NULL, true, now(), now()),
    ('Bitstamp', crypto_exchange_type_id, 'Luxembourg-based cryptocurrency exchange', 'https://www.bitstamp.net', NULL, true, now(), now()),
    ('Gemini', crypto_exchange_type_id, 'American cryptocurrency exchange and custodian founded by the Winklevoss twins', 'https://www.gemini.com', NULL, true, now(), now()),
    ('KuCoin', crypto_exchange_type_id, 'Global cryptocurrency exchange providing trading services', 'https://www.kucoin.com', NULL, true, now(), now()),
    ('OKX', crypto_exchange_type_id, 'Seychelles-based cryptocurrency exchange offering spot and derivatives trading', 'https://www.okx.com', NULL, true, now(), now()),
    ('Huobi', crypto_exchange_type_id, 'Seychelles-based cryptocurrency exchange', 'https://www.huobi.com', NULL, true, now(), now()),
    ('Bybit', crypto_exchange_type_id, 'Cryptocurrency exchange offering derivatives trading', 'https://www.bybit.com', NULL, true, now(), now()),
    ('Crypto.com', crypto_exchange_type_id, 'Cryptocurrency platform offering exchange, wallet, and payment services', 'https://www.crypto.com', NULL, true, now(), now()),
    ('Gate.io', crypto_exchange_type_id, 'Cryptocurrency exchange providing spot and derivatives trading', 'https://www.gate.io', NULL, true, now(), now()),
    ('Bitget', crypto_exchange_type_id, 'Cryptocurrency exchange specializing in derivatives trading', 'https://www.bitget.com', NULL, true, now(), now()),
    ('MEXC', crypto_exchange_type_id, 'Global cryptocurrency exchange providing trading services', 'https://www.mexc.com', NULL, true, now(), now()),
    ('Upbit', crypto_exchange_type_id, 'South Korean cryptocurrency exchange', 'https://www.upbit.com', NULL, true, now(), now()),
    ('Bithumb', crypto_exchange_type_id, 'South Korean cryptocurrency exchange', 'https://www.bithumb.com', NULL, true, now(), now()),
    ('Bittrex', crypto_exchange_type_id, 'American cryptocurrency exchange', 'https://www.bittrex.com', NULL, true, now(), now()),
    ('Poloniex', crypto_exchange_type_id, 'Cryptocurrency exchange offering spot trading', 'https://www.poloniex.com', NULL, true, now(), now()),
    ('Coincheck', crypto_exchange_type_id, 'Japanese cryptocurrency exchange', 'https://www.coincheck.com', NULL, true, now(), now()),
    ('bitFlyer', crypto_exchange_type_id, 'Japanese cryptocurrency exchange', 'https://www.bitflyer.com', NULL, true, now(), now()),
    ('Bitso', crypto_exchange_type_id, 'Mexican cryptocurrency exchange platform', 'https://www.bitso.com', NULL, true, now(), now()),
    ('Mercado Bitcoin', crypto_exchange_type_id, 'Brazilian cryptocurrency exchange', 'https://www.mercadobitcoin.com.br', NULL, true, now(), now()),
    ('CoinDCX', crypto_exchange_type_id, 'Indian cryptocurrency exchange', 'https://www.coindcx.com', NULL, true, now(), now()),
    ('WazirX', crypto_exchange_type_id, 'Indian cryptocurrency exchange', 'https://www.wazirx.com', NULL, true, now(), now()),
    ('Luno', crypto_exchange_type_id, 'Cryptocurrency exchange and wallet provider operating in Africa and Europe', 'https://www.luno.com', NULL, true, now(), now()),

    -- ========================================
    -- CRYPTO WALLETS - BLOCKCHAIN NETWORKS
    -- ========================================
    ('Bitcoin Network', crypto_wallet_type_id, 'First decentralized cryptocurrency network enabling peer-to-peer transactions', 'https://bitcoin.org', NULL, true, now(), now()),
    ('Ethereum', crypto_wallet_type_id, 'Decentralized blockchain platform supporting smart contracts and dApps', 'https://ethereum.org', NULL, true, now(), now()),
    ('Binance Smart Chain', crypto_wallet_type_id, 'Blockchain network running parallel to Binance Chain with smart contract functionality', 'https://www.bnbchain.org', NULL, true, now(), now()),
    ('Polygon', crypto_wallet_type_id, 'Layer-2 scaling solution for Ethereum providing faster and cheaper transactions', 'https://polygon.technology', NULL, true, now(), now()),
    ('Solana', crypto_wallet_type_id, 'High-performance blockchain supporting fast transactions and low fees', 'https://solana.com', NULL, true, now(), now()),
    ('Avalanche', crypto_wallet_type_id, 'Platform for decentralized applications and custom blockchain networks', 'https://www.avax.network', NULL, true, now(), now()),
    ('Cardano', crypto_wallet_type_id, 'Proof-of-stake blockchain platform with focus on security and sustainability', 'https://cardano.org', NULL, true, now(), now()),
    ('Polkadot', crypto_wallet_type_id, 'Multi-chain network enabling different blockchains to transfer messages and value', 'https://polkadot.network', NULL, true, now(), now()),
    ('Cosmos', crypto_wallet_type_id, 'Network of independent blockchains connected through Inter-Blockchain Communication protocol', 'https://cosmos.network', NULL, true, now(), now()),
    ('Arbitrum', crypto_wallet_type_id, 'Layer-2 scaling solution for Ethereum using optimistic rollups', 'https://arbitrum.io', NULL, true, now(), now()),
    ('Optimism', crypto_wallet_type_id, 'Layer-2 scaling solution for Ethereum providing faster and cheaper transactions', 'https://www.optimism.io', NULL, true, now(), now()),
    ('Base', crypto_wallet_type_id, 'Layer-2 blockchain built on Ethereum by Coinbase', 'https://base.org', NULL, true, now(), now()),
    ('Tron', crypto_wallet_type_id, 'Decentralized blockchain platform focused on content sharing and entertainment', 'https://tron.network', NULL, true, now(), now()),
    ('Ripple', crypto_wallet_type_id, 'Real-time gross settlement system and currency exchange network', 'https://ripple.com', NULL, true, now(), now()),
    ('Litecoin', crypto_wallet_type_id, 'Peer-to-peer cryptocurrency created as silver to Bitcoin''s gold', 'https://litecoin.org', NULL, true, now(), now()),
    ('Bitcoin Cash', crypto_wallet_type_id, 'Cryptocurrency fork of Bitcoin with larger block size', 'https://www.bitcoincash.org', NULL, true, now(), now()),
    ('Stellar', crypto_wallet_type_id, 'Open network for storing and moving money with focus on financial inclusion', 'https://www.stellar.org', NULL, true, now(), now()),
    ('Algorand', crypto_wallet_type_id, 'Pure proof-of-stake blockchain platform with focus on scalability and speed', 'https://www.algorand.com', NULL, true, now(), now()),
    ('Near Protocol', crypto_wallet_type_id, 'Sharded proof-of-stake blockchain focused on usability and scalability', 'https://near.org', NULL, true, now(), now()),
    ('Fantom', crypto_wallet_type_id, 'High-performance, scalable, and secure smart contract platform', 'https://fantom.foundation', NULL, true, now(), now()),
    ('Cronos', crypto_wallet_type_id, 'EVM-compatible blockchain built on Cosmos SDK by Crypto.com', 'https://cronos.org', NULL, true, now(), now()),
    ('Hedera', crypto_wallet_type_id, 'Public network using hashgraph consensus for high throughput and low fees', 'https://hedera.com', NULL, true, now(), now()),
    ('Aptos', crypto_wallet_type_id, 'Layer-1 blockchain focused on safety and scalability', 'https://aptoslabs.com', NULL, true, now(), now()),
    ('Sui', crypto_wallet_type_id, 'Layer-1 blockchain with focus on instant transaction finality', 'https://sui.io', NULL, true, now(), now()),

    -- ========================================
    -- PAYMENT PLATFORMS & DIGITAL WALLETS
    -- ========================================
    ('PayPal', other_type_id, 'American multinational financial technology company operating online payments system', 'https://www.paypal.com', NULL, true, now(), now()),
    ('Venmo', other_type_id, 'American mobile payment service owned by PayPal', 'https://www.venmo.com', NULL, true, now(), now()),
    ('Cash App', other_type_id, 'Mobile payment service developed by Block, Inc.', 'https://www.cash.app', NULL, true, now(), now()),
    ('Zelle', other_type_id, 'American peer-to-peer payments network owned by major banks', 'https://www.zellepay.com', NULL, true, now(), now()),
    ('Apple Pay', other_type_id, 'Mobile payment and digital wallet service by Apple', 'https://www.apple.com/apple-pay', NULL, true, now(), now()),
    ('Google Pay', other_type_id, 'Digital wallet platform and online payment system developed by Google', 'https://pay.google.com', NULL, true, now(), now()),
    ('Samsung Pay', other_type_id, 'Mobile payment and digital wallet service by Samsung Electronics', 'https://www.samsung.com/samsung-pay', NULL, true, now(), now()),
    ('Revolut', other_type_id, 'British financial technology company offering banking services, currency exchange, and trading', 'https://www.revolut.com', NULL, true, now(), now()),
    ('Wise', other_type_id, 'British financial technology company providing international money transfers', 'https://www.wise.com', NULL, true, now(), now()),
    ('N26', other_type_id, 'German neobank offering mobile banking services', 'https://www.n26.com', NULL, true, now(), now()),
    ('Monzo', other_type_id, 'British online bank providing mobile banking services', 'https://www.monzo.com', NULL, true, now(), now()),
    ('Starling Bank', other_type_id, 'British digital bank offering mobile-only current and business accounts', 'https://www.starlingbank.com', NULL, true, now(), now()),
    ('Chime', other_type_id, 'American financial technology company providing fee-free mobile banking services', 'https://www.chime.com', NULL, true, now(), now()),
    ('Stripe', other_type_id, 'American financial services and software company for online payment processing', 'https://www.stripe.com', NULL, true, now(), now()),
    ('Square', other_type_id, 'American financial services and digital payments company', 'https://www.squareup.com', NULL, true, now(), now()),
    ('Adyen', other_type_id, 'Dutch payment company allowing businesses to accept e-commerce payments', 'https://www.adyen.com', NULL, true, now(), now()),
    ('Klarna', other_type_id, 'Swedish fintech company providing online financial services including payment solutions', 'https://www.klarna.com', NULL, true, now(), now()),
    ('Affirm', other_type_id, 'American financial technology company offering point-of-sale installment loans', 'https://www.affirm.com', NULL, true, now(), now()),
    ('Afterpay', other_type_id, 'Australian financial technology company operating a buy now, pay later service', 'https://www.afterpay.com', NULL, true, now(), now()),
    ('Alipay', other_type_id, 'Chinese third-party mobile and online payment platform by Ant Group', 'https://www.alipay.com', NULL, true, now(), now()),
    ('WeChat Pay', other_type_id, 'Chinese mobile payment service by Tencent', 'https://www.wechat.com', NULL, true, now(), now()),
    ('Paytm', other_type_id, 'Indian digital payment and financial services company', 'https://www.paytm.com', NULL, true, now(), now()),
    ('PhonePe', other_type_id, 'Indian digital payment and financial services company', 'https://www.phonepe.com', NULL, true, now(), now()),
    ('M-Pesa', other_type_id, 'Mobile phone-based money transfer service founded in Kenya', 'https://www.vodafone.com/what-we-do/services/m-pesa', NULL, true, now(), now()),
    ('Mercado Pago', other_type_id, 'Argentine online payments platform by Mercado Libre', 'https://www.mercadopago.com', NULL, true, now(), now()),
    ('PicPay', other_type_id, 'Brazilian digital wallet and payment platform', 'https://www.picpay.com', NULL, true, now(), now()),
    ('GrabPay', other_type_id, 'Digital wallet service by Grab in Southeast Asia', 'https://www.grab.com/sg/pay', NULL, true, now(), now()),
    ('GCash', other_type_id, 'Filipino mobile wallet and payment service', 'https://www.gcash.com', NULL, true, now(), now()),
    ('Kakao Pay', other_type_id, 'South Korean mobile payment and digital wallet service', 'https://www.kakaopay.com', NULL, true, now(), now()),
    ('Line Pay', other_type_id, 'Mobile payment service integrated with Line messaging app', 'https://www.linepay.com', NULL, true, now(), now()),

    -- ========================================
    -- INVESTMENT FUNDS
    -- ========================================
    ('BlackRock', investment_fund_type_id, 'American multinational investment management corporation and world''s largest asset manager', 'https://www.blackrock.com', NULL, true, now(), now()),
    ('Vanguard Group', investment_fund_type_id, 'American investment management company known for low-cost index funds', 'https://www.vanguard.com', NULL, true, now(), now()),
    ('State Street Global Advisors', investment_fund_type_id, 'Investment management component of State Street Corporation', 'https://www.ssga.com', NULL, true, now(), now()),
    ('Fidelity Investments', investment_fund_type_id, 'American multinational financial services corporation', 'https://www.fidelity.com', NULL, true, now(), now()),
    ('BNY Mellon Investment Management', investment_fund_type_id, 'Investment management division of BNY Mellon', 'https://www.bnymellon.com', NULL, true, now(), now()),
    ('Amundi', investment_fund_type_id, 'French asset management company', 'https://www.amundi.com', NULL, true, now(), now()),
    ('PIMCO', investment_fund_type_id, 'American investment management firm focusing on fixed income', 'https://www.pimco.com', NULL, true, now(), now()),
    ('T. Rowe Price', investment_fund_type_id, 'American publicly owned global investment management firm', 'https://www.troweprice.com', NULL, true, now(), now()),
    ('Franklin Templeton', investment_fund_type_id, 'American multinational holding company providing investment management services', 'https://www.franklintempleton.com', NULL, true, now(), now()),
    ('Capital Group', investment_fund_type_id, 'American financial services company managing American Funds', 'https://www.capitalgroup.com', NULL, true, now(), now()),
    ('J.P. Morgan Asset Management', investment_fund_type_id, 'Asset management division of JPMorgan Chase', 'https://www.jpmorganassetmanagement.com', NULL, true, now(), now()),
    ('Invesco', investment_fund_type_id, 'American independent investment management company', 'https://www.invesco.com', NULL, true, now(), now()),
    ('Schroders', investment_fund_type_id, 'British multinational asset management company', 'https://www.schroders.com', NULL, true, now(), now()),
    ('Northern Trust Asset Management', investment_fund_type_id, 'American wealth management company', 'https://www.northerntrust.com', NULL, true, now(), now()),
    ('Nuveen', investment_fund_type_id, 'American asset management firm and subsidiary of TIAA', 'https://www.nuveen.com', NULL, true, now(), now()),

    -- ========================================
    -- PRIVATE EQUITY PLATFORMS
    -- ========================================
    ('Carta', private_equity_type_id, 'Platform for equity management, valuations, and cap table management for private companies', 'https://www.carta.com', NULL, true, now(), now()),
    ('EquityZen', private_equity_type_id, 'Marketplace connecting investors with employees of private companies for pre-IPO investments', 'https://www.equityzen.com', NULL, true, now(), now()),
    ('Forge Global', private_equity_type_id, 'Private securities marketplace providing access to pre-IPO investment opportunities', 'https://www.forgeglobal.com', NULL, true, now(), now()),
    ('SharesPost', private_equity_type_id, 'Marketplace for buying and selling shares in private companies', 'https://www.sharespost.com', NULL, true, now(), now()),
    ('Ledgy', private_equity_type_id, 'European equity management platform for startups and investors', 'https://www.ledgy.com', NULL, true, now(), now()),
    ('AngelList', private_equity_type_id, 'Platform for startups, angel investors, and job-seekers in tech companies', 'https://www.angellist.com', NULL, true, now(), now()),
    ('Republic', private_equity_type_id, 'Investment platform for startup investing, real estate, and crypto', 'https://www.republic.com', NULL, true, now(), now()),

    -- ========================================
    -- REAL ESTATE PLATFORMS
    -- ========================================
    ('Fundrise', real_estate_type_id, 'American financial technology company for real estate crowdfunding', 'https://www.fundrise.com', NULL, true, now(), now()),
    ('RealtyMogul', real_estate_type_id, 'Online real estate crowdfunding platform', 'https://www.realtymogul.com', NULL, true, now(), now()),
    ('CrowdStreet', real_estate_type_id, 'Online commercial real estate investing platform', 'https://www.crowdstreet.com', NULL, true, now(), now()),
    ('Arrived Homes', real_estate_type_id, 'Platform for investing in shares of rental homes', 'https://www.arrived.com', NULL, true, now(), now()),
    ('Roofstock', real_estate_type_id, 'Online marketplace for single-family rental homes', 'https://www.roofstock.com', NULL, true, now(), now()),
    ('EquityMultiple', real_estate_type_id, 'Commercial real estate investment platform', 'https://www.equitymultiple.com', NULL, true, now(), now()),
    ('Yieldstreet', real_estate_type_id, 'Alternative investment platform including real estate opportunities', 'https://www.yieldstreet.com', NULL, true, now(), now())

  ON CONFLICT (website) DO NOTHING;

END $$;