-- Custom SQL migration file, put your code below! --
-- Seed common fiat currencies
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
  -- Major World Currencies
  (
    'USD',
    'United States Dollar',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'EUR',
    'Euro',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'GBP',
    'British Pound Sterling',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'JPY',
    'Japanese Yen',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    0,
    true,
    now (),
    now ()
  ),
  (
    'CAD',
    'Canadian Dollar',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'AUD',
    'Australian Dollar',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'CHF',
    'Swiss Franc',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'CNY',
    'Chinese Renminbi Yuan',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'SEK',
    'Swedish Krona',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'NOK',
    'Norwegian Krone',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'DKK',
    'Danish Krone',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'PLN',
    'Polish Złoty',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'CZK',
    'Czech Koruna',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'HUF',
    'Hungarian Forint',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'RON',
    'Romanian Leu',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  -- Asian Currencies
  (
    'KRW',
    'South Korean Won',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    0,
    true,
    now (),
    now ()
  ),
  (
    'SGD',
    'Singapore Dollar',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'HKD',
    'Hong Kong Dollar',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'TWD',
    'New Taiwan Dollar',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'INR',
    'Indian Rupee',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'THB',
    'Thai Baht',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'MYR',
    'Malaysian Ringgit',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'IDR',
    'Indonesian Rupiah',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    0,
    true,
    now (),
    now ()
  ),
  (
    'PHP',
    'Philippine Peso',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'VND',
    'Vietnamese Đồng',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    0,
    true,
    now (),
    now ()
  ),
  -- Middle East & Africa
  (
    'AED',
    'United Arab Emirates Dirham',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'SAR',
    'Saudi Riyal',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'QAR',
    'Qatari Riyal',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'KWD',
    'Kuwaiti Dinar',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    3,
    true,
    now (),
    now ()
  ),
  (
    'BHD',
    'Bahraini Dinar',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    3,
    true,
    now (),
    now ()
  ),
  (
    'OMR',
    'Omani Rial',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    3,
    true,
    now (),
    now ()
  ),
  (
    'JOD',
    'Jordanian Dinar',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    3,
    true,
    now (),
    now ()
  ),
  (
    'ILS',
    'Israeli New Sheqel',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'TRY',
    'Turkish Lira',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'ZAR',
    'South African Rand',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'EGP',
    'Egyptian Pound',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'NGN',
    'Nigerian Naira',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'KES',
    'Kenyan Shilling',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  -- Latin America
  (
    'BRL',
    'Brazilian Real',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'MXN',
    'Mexican Peso',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'ARS',
    'Argentine Peso',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'CLP',
    'Chilean Peso',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    0,
    true,
    now (),
    now ()
  ),
  (
    'COP',
    'Colombian Peso',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'PEN',
    'Peruvian Sol',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'UYU',
    'Uruguayan Peso',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  -- Eastern Europe & Russia
  (
    'RUB',
    'Russian Ruble',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'UAH',
    'Ukrainian Hryvnia',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'BGN',
    'Bulgarian Lev',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'HRK',
    'Croatian Kuna',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'RSD',
    'Serbian Dinar',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  -- Pacific
  (
    'NZD',
    'New Zealand Dollar',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  ),
  (
    'FJD',
    'Fijian Dollar',
    (
      SELECT
        id
      FROM
        token_types
      WHERE
        code = 'fiat'
    ),
    2,
    true,
    now (),
    now ()
  );