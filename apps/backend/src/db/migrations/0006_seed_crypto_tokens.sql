-- Custom SQL migration file, put your code below! --
-- Seed popular cryptocurrencies
INSERT INTO
  tokens (
    symbol,
    name,
    type_id,
    decimals,
    is_active,
    created_at,
    updated_at
  )
VALUES
  -- Top Cryptocurrencies by Market Cap
  (
    'BTC',
    'Bitcoin',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    8,
    true,
    now (),
    now ()
  ),
  (
    'ETH',
    'Ethereum',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'USDT',
    'Tether USDt',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    6,
    true,
    now (),
    now ()
  ),
  (
    'BNB',
    'BNB',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'SOL',
    'Solana',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    9,
    true,
    now (),
    now ()
  ),
  (
    'USDC',
    'USD Coin',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    6,
    true,
    now (),
    now ()
  ),
  (
    'XRP',
    'XRP',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    6,
    true,
    now (),
    now ()
  ),
  (
    'DOGE',
    'Dogecoin',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    8,
    true,
    now (),
    now ()
  ),
  (
    'ADA',
    'Cardano',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    6,
    true,
    now (),
    now ()
  ),
  (
    'TRX',
    'TRON',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    6,
    true,
    now (),
    now ()
  ),
  (
    'AVAX',
    'Avalanche',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'SHIB',
    'Shiba Inu',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'LINK',
    'Chainlink',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'DOT',
    'Polkadot',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    10,
    true,
    now (),
    now ()
  ),
  (
    'MATIC',
    'Polygon',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'LTC',
    'Litecoin',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    8,
    true,
    now (),
    now ()
  ),
  (
    'BCH',
    'Bitcoin Cash',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    8,
    true,
    now (),
    now ()
  ),
  (
    'UNI',
    'Uniswap',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'ICP',
    'Internet Computer',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    8,
    true,
    now (),
    now ()
  ),
  (
    'NEAR',
    'NEAR Protocol',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    24,
    true,
    now (),
    now ()
  ),
  (
    'APT',
    'Aptos',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    8,
    true,
    now (),
    now ()
  ),
  (
    'SUI',
    'Sui',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    9,
    true,
    now (),
    now ()
  ),
  (
    'HBAR',
    'Hedera',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    8,
    true,
    now (),
    now ()
  ),
  (
    'FIL',
    'Filecoin',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'VET',
    'VeChain',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'ATOM',
    'Cosmos',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    6,
    true,
    now (),
    now ()
  ),
  (
    'XMR',
    'Monero',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    12,
    true,
    now (),
    now ()
  ),
  (
    'ETC',
    'Ethereum Classic',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'ALGO',
    'Algorand',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    6,
    true,
    now (),
    now ()
  ),
  (
    'XLM',
    'Stellar',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    7,
    true,
    now (),
    now ()
  ),
  -- DeFi Tokens
  (
    'AAVE',
    'Aave',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'COMP',
    'Compound',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'MKR',
    'Maker',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'SUSHI',
    'SushiSwap',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'CRV',
    'Curve DAO Token',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'SNX',
    'Synthetix',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'YFI',
    'yearn.finance',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    '1INCH',
    '1inch Network',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  -- Stablecoins
  (
    'DAI',
    'Dai',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'BUSD',
    'Binance USD',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'FRAX',
    'Frax',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'TUSD',
    'TrueUSD',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'FDUSD',
    'First Digital USD',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  -- Gaming & NFT Tokens
  (
    'SAND',
    'The Sandbox',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'MANA',
    'Decentraland',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'AXS',
    'Axie Infinity',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'ENJ',
    'Enjin Coin',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'FLOW',
    'Flow',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    8,
    true,
    now (),
    now ()
  ),
  (
    'IMX',
    'Immutable X',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  -- Meme Coins
  (
    'PEPE',
    'Pepe',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'FLOKI',
    'FLOKI',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    9,
    true,
    now (),
    now ()
  ),
  (
    'BONK',
    'Bonk',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    5,
    true,
    now (),
    now ()
  ),
  -- AI & Tech Tokens
  (
    'FET',
    'Fetch.ai',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'OCEAN',
    'Ocean Protocol',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'GRT',
    'The Graph',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'RENDER',
    'Render Token',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  -- Layer 2 & Infrastructure
  (
    'ARB',
    'Arbitrum',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'OP',
    'Optimism',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'LDO',
    'Lido DAO',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'BLUR',
    'Blur',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  -- Privacy Coins
  (
    'ZEC',
    'Zcash',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    8,
    true,
    now (),
    now ()
  ),
  (
    'DASH',
    'Dash',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    8,
    true,
    now (),
    now ()
  ),
  -- Other Popular Tokens
  (
    'THETA',
    'Theta Network',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'MINA',
    'Mina',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    9,
    true,
    now (),
    now ()
  ),
  (
    'ROSE',
    'Oasis Network',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    18,
    true,
    now (),
    now ()
  ),
  (
    'KSM',
    'Kusama',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'crypto'
    ),
    12,
    true,
    now (),
    now ()
  );