-- Custom SQL migration file, put your code below! --
-- Seed fiat currency tokens
-- This migration inserts all major world fiat currencies into the tokens table

-- First, get the fiat token type ID
DO $$
DECLARE
  fiat_type_id UUID;
BEGIN
  -- Get the fiat token type ID
  SELECT id INTO fiat_type_id FROM token_types WHERE code = 'fiat';

  -- Insert all major world fiat currencies
  INSERT INTO tokens (
    symbol,
    name,
    type_id,
    decimals,
    icon_url,
    provider_metadata,
    is_active,
    created_at,
    updated_at
  )
  VALUES
    -- Major currencies (G7 + China)
    ('USD', 'United States Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('EUR', 'Euro', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('JPY', 'Japanese Yen', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('GBP', 'British Pound Sterling', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('CAD', 'Canadian Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('CHF', 'Swiss Franc', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('CNY', 'Chinese Yuan', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    
    -- Other major global currencies
    ('AUD', 'Australian Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('NZD', 'New Zealand Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('HKD', 'Hong Kong Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('SGD', 'Singapore Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    
    -- Asian currencies
    ('INR', 'Indian Rupee', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('KRW', 'South Korean Won', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('IDR', 'Indonesian Rupiah', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('THB', 'Thai Baht', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('MYR', 'Malaysian Ringgit', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('PHP', 'Philippine Peso', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('VND', 'Vietnamese Dong', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('TWD', 'New Taiwan Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('PKR', 'Pakistani Rupee', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('BDT', 'Bangladeshi Taka', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('LKR', 'Sri Lankan Rupee', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    
    -- Middle Eastern currencies
    ('SAR', 'Saudi Riyal', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('AED', 'UAE Dirham', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('QAR', 'Qatari Riyal', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('KWD', 'Kuwaiti Dinar', fiat_type_id, 3, NULL, '{}', true, now(), now()),
    ('BHD', 'Bahraini Dinar', fiat_type_id, 3, NULL, '{}', true, now(), now()),
    ('OMR', 'Omani Rial', fiat_type_id, 3, NULL, '{}', true, now(), now()),
    ('ILS', 'Israeli New Shekel', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('TRY', 'Turkish Lira', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('JOD', 'Jordanian Dinar', fiat_type_id, 3, NULL, '{}', true, now(), now()),
    ('LBP', 'Lebanese Pound', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    
    -- European currencies (non-Euro)
    ('SEK', 'Swedish Krona', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('NOK', 'Norwegian Krone', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('DKK', 'Danish Krone', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('PLN', 'Polish Zloty', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('CZK', 'Czech Koruna', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('HUF', 'Hungarian Forint', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('RON', 'Romanian Leu', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('BGN', 'Bulgarian Lev', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('HRK', 'Croatian Kuna', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('RSD', 'Serbian Dinar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('UAH', 'Ukrainian Hryvnia', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('RUB', 'Russian Ruble', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('ISK', 'Icelandic Krona', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    
    -- Latin American currencies
    ('BRL', 'Brazilian Real', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('MXN', 'Mexican Peso', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('ARS', 'Argentine Peso', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('CLP', 'Chilean Peso', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('COP', 'Colombian Peso', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('PEN', 'Peruvian Sol', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('UYU', 'Uruguayan Peso', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('BOB', 'Bolivian Boliviano', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('PYG', 'Paraguayan Guarani', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('VES', 'Venezuelan Bolívar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    
    -- African currencies
    ('ZAR', 'South African Rand', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('NGN', 'Nigerian Naira', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('EGP', 'Egyptian Pound', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('KES', 'Kenyan Shilling', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('GHS', 'Ghanaian Cedi', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('TZS', 'Tanzanian Shilling', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('UGX', 'Ugandan Shilling', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('MAD', 'Moroccan Dirham', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('TND', 'Tunisian Dinar', fiat_type_id, 3, NULL, '{}', true, now(), now()),
    ('ETB', 'Ethiopian Birr', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('XOF', 'West African CFA Franc', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('XAF', 'Central African CFA Franc', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    
    -- Oceania currencies
    ('FJD', 'Fijian Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('PGK', 'Papua New Guinean Kina', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    
    -- Other notable currencies
    ('AFN', 'Afghan Afghani', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('AMD', 'Armenian Dram', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('AZN', 'Azerbaijani Manat', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('BYN', 'Belarusian Ruble', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('GEL', 'Georgian Lari', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('KZT', 'Kazakhstani Tenge', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('KGS', 'Kyrgyzstani Som', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('MNT', 'Mongolian Tugrik', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('UZS', 'Uzbekistani Som', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('TMT', 'Turkmenistani Manat', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('TJS', 'Tajikistani Somoni', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    
    -- Caribbean and Central American currencies
    ('JMD', 'Jamaican Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('TTD', 'Trinidad and Tobago Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('BBD', 'Barbadian Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('BZD', 'Belize Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('GTQ', 'Guatemalan Quetzal', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('HNL', 'Honduran Lempira', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('NIO', 'Nicaraguan Córdoba', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('CRC', 'Costa Rican Colón', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('PAB', 'Panamanian Balboa', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('DOP', 'Dominican Peso', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('HTG', 'Haitian Gourde', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('CUP', 'Cuban Peso', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    
    -- Pegged/Special currencies
    ('XCD', 'East Caribbean Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    
    -- Baltic countries
    ('ALL', 'Albanian Lek', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('MKD', 'Macedonian Denar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('BAM', 'Bosnia-Herzegovina Convertible Mark', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    
    -- Additional Asian currencies
    ('LAK', 'Laotian Kip', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('KHR', 'Cambodian Riel', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('MMK', 'Myanmar Kyat', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('BND', 'Brunei Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('NPR', 'Nepalese Rupee', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('BTN', 'Bhutanese Ngultrum', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('MVR', 'Maldivian Rufiyaa', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    
    -- Additional Middle Eastern currencies
    ('IQD', 'Iraqi Dinar', fiat_type_id, 3, NULL, '{}', true, now(), now()),
    ('IRR', 'Iranian Rial', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('SYP', 'Syrian Pound', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('YER', 'Yemeni Rial', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    
    -- Additional African currencies
    ('BWP', 'Botswana Pula', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('MUR', 'Mauritian Rupee', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('MWK', 'Malawian Kwacha', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('MZN', 'Mozambican Metical', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('NAD', 'Namibian Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('ZMW', 'Zambian Kwacha', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('ZWL', 'Zimbabwean Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('AOA', 'Angolan Kwanza', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('DZD', 'Algerian Dinar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('LYD', 'Libyan Dinar', fiat_type_id, 3, NULL, '{}', true, now(), now()),
    ('SDG', 'Sudanese Pound', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('SOS', 'Somali Shilling', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('DJF', 'Djiboutian Franc', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('ERN', 'Eritrean Nakfa', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('RWF', 'Rwandan Franc', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('BIF', 'Burundian Franc', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('SZL', 'Swazi Lilangeni', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('LSL', 'Lesotho Loti', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('GMD', 'Gambian Dalasi', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('GNF', 'Guinean Franc', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('SLL', 'Sierra Leonean Leone', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('LRD', 'Liberian Dollar', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('MRU', 'Mauritanian Ouguiya', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('SCR', 'Seychellois Rupee', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('CVE', 'Cape Verdean Escudo', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('STN', 'São Tomé and Príncipe Dobra', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('KMF', 'Comorian Franc', fiat_type_id, 0, NULL, '{}', true, now(), now()),
    ('CDF', 'Congolese Franc', fiat_type_id, 2, NULL, '{}', true, now(), now()),
    ('MGA', 'Malagasy Ariary', fiat_type_id, 2, NULL, '{}', true, now(), now())
  ON CONFLICT (symbol, type_id) DO NOTHING;

END $$;