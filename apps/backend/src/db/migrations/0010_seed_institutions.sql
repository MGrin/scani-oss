-- Custom SQL migration file, put your code below! ---- Custom SQL migration file, put your code below! --

-- Seed institutions with comprehensive financial institutions
-- This includes banks, neobanks, brokers, crypto exchanges, fintech apps, etc.

-- First, get the institution type IDs we'll need
DO $$ 
DECLARE
    bank_type UUID;
    broker_type UUID;
    crypto_wallet_type UUID;
    crypto_exchange_type UUID;
    investment_fund_type UUID;
    private_equity_type UUID;
    real_estate_type UUID;
    other_type UUID;
BEGIN
    -- Get type IDs
    select id into bank_type FROM institution_types where code = 'bank';
    select id into broker_type FROM institution_types where code = 'broker';
    select id into crypto_wallet_type FROM institution_types where code = 'crypto_wallet';
    select id into crypto_exchange_type FROM institution_types where code = 'crypto_exchange';
    select id into investment_fund_type FROM institution_types where code = 'investment_fund';
    select id into private_equity_type FROM institution_types where code = 'private_equity';
    select id into real_estate_type FROM institution_types where code = 'real_estate';
    select id into other_type FROM institution_types where code = 'other';
    
    -- Major US Banks
    INSERT INTO institutions (id, name, type_id, description, website, is_active, created_at, updated_at) VALUES
    (gen_random_uuid(), 'Chase', bank_type, 'Chase online; credit cards, mortgages, commercial banking, auto loans, investing & retirement planning, checking and business banking.', 'https://chase.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Bank of America', bank_type, 'What would you like the power to do? At Bank of America, our purpose is to help make financial lives better through the power of every connection.', 'https://bankofamerica.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Wells Fargo', bank_type, 'See how we’re helping customers succeed and communities thrive. For support 7 days a week, message us @WellsFargo', 'https://wellsfargo.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Citi', bank_type, 'Investment bank and financial services corporation', 'https://citibank.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'US Bank', bank_type, 'Experience personalized banking services for your unique needs with U.S. Bank', 'https://usbank.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'PNC', bank_type, 'PNC Bank offers a wide range of personal banking services including checking and savings accounts, credit cards, mortgage loans, auto loans and much more.', 'https://pnc.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Capital One', bank_type, 'Explore Capital One accounts for you and your business', 'https://capitalone.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'TD Canada Trust', bank_type, 'Explore what TD Canada Trust is all about. Learn about our values, initiatives, reporting, news, careers, recent awards, and more.', 'https://td.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Truist Bank', bank_type, 'Your journey to better banking starts with Truist. Checking and savings accounts, credit cards, mortgages, small business, commercial banking, and more.', 'https://truist.com', true, NOW(), NOW()),

    -- Regional Banks
    (gen_random_uuid(), 'Regions Bank', bank_type, 'Regional bank serving the South, Midwest, and Texas', 'https://regions.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'KeyBank', bank_type, 'Enjoy the benefits of being a KeyBank client. We offer checking & savings accounts, credit cards, insurance, and loans. Open your KeyBank account today!', 'https://key.com', true, NOW(), NOW()),
    (gen_random_uuid(), '53 Bank', bank_type, 'Fifth Third Bank has all the personal banking solutions to suit your needs. Learn about the features and benefits of our personal bank account today!', 'https://53.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Huntington', bank_type, 'Huntington provides online banking solutions, mortgage, investing, loans, credit cards, and personal, small business, and commercial financial services.', 'https://huntington.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'MTB Bank', bank_type, 'With a community bank approach, M&T Bank helps people reach their personal and business goals with banking, mortgage, loan and investment services.', 'https://mtb.com', true, NOW(), NOW()),

    -- Credit Unions (using bank type since credit_union doesn't exist)
    (gen_random_uuid(), 'Navy Federal Credit Union', bank_type, 'Navy Federal Credit Union is an armed forces bank serving the Navy, Army, Marine Corps, Air Force, Space Force, Coast Guard, veterans, DoD & their families. Join now!', 'https://navyfederal.org', true, NOW(), NOW()),
    (gen_random_uuid(), 'State Employees Credit Union', bank_type, 'Second largest credit union in the United States', 'https://secu.org', true, NOW(), NOW()),
    (gen_random_uuid(), 'PenFed Credit Union', bank_type, 'PenFed Credit Union empowers you to achieve financial success with checking and savings, award', 'https://penfed.org', true, NOW(), NOW()),
    (gen_random_uuid(), 'Alliant Credit Union', bank_type, 'Digital-first credit union', 'https://alliantcreditunion.org', true, NOW(), NOW()),

    -- Neobanks and Digital Banks (using other type since fintech doesn't exist)
    (gen_random_uuid(), 'Chime', bank_type, 'Digital banking platform with no monthly fees', 'https://chime.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Ally', bank_type, 'Manage your money with Ally: online banking, auto financing, and investments. Financial products designed to help you pursue your goals.', 'https://ally.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Marcus', bank_type, 'Online personal finance platform', 'https://marcus.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Discover', bank_type, 'Discover offers online banking, reward credit cards, home equity loans, and personal loans to help meet your financial needs.', 'https://discover.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Varo Bank', bank_type, 'Mobile-first digital bank', 'https://varobank.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Current', bank_type, 'Mobile banking done better. Build credit while you bank. No overdraft fees/hidden fees. Current is a fintech not a bank. Banking services provided by Choice Financial Group, Member FDIC, and Cross River Bank, Member FDIC.', 'https://current.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Revolut', bank_type, 'Digital banking and financial services', 'https://revolut.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Monzo', bank_type, 'Organise, save & invest with a free UK current account, joint account or business account. Make your money more Monzo.', 'https://monzo.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'N26', bank_type, 'N26 is the first bank you&#x27;ll love. Beautifully simple, 100% mobile, and trusted by millions. Open your free bank account in minutes.', 'https://n26.com', true, NOW(), NOW()),

    -- Investment Brokers
    (gen_random_uuid(), 'Charles Schwab', broker_type, 'Charles Schwab offers investment products and services, including brokerage and retirement accounts, online trading and more.', 'https://schwab.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Fidelity International', broker_type, 'Multinational financial services corporation', 'https://fidelity.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Vanguard', broker_type, 'Investment management company', 'https://vanguard.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'E*TRADE', broker_type, 'Stop waiting. Start investing. Lifelong dreams don', 'https://etrade.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'TD Ameritrade', broker_type, 'Online broker for stock and options trading', 'https://tdameritrade.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Interactive Brokers', broker_type, 'Electronic trading platform', 'https://interactivebrokers.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Robinhood', broker_type, 'Commission-free stock trading platform', 'https://robinhood.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Webull', broker_type, 'Start investing with Webull&apos;s intuitive platform for stocks, options, and ETFs. Join now for free trading tools and community insights.', 'https://webull.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'M1 Finance', broker_type, 'Earn 4.00% APY with high', 'https://m1finance.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Tastyworks', broker_type, 'Options trading platform', 'https://tastyworks.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Merrilledge', broker_type, 'Merrill Edge offers a wide range of investment products and advice, including brokerage and retirement accounts, online trading, and financial research.', 'https://merrilledge.com', true, NOW(), NOW()),

    -- Robo-Advisors
    (gen_random_uuid(), 'Betterment', broker_type, 'Automated investing and savings platform', 'https://betterment.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'WealthFront', broker_type, 'Wealthfront makes building wealth easy. Earn 4.00% APY on your uninvested cash and invest in expert', 'https://wealthfront.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Acorns', broker_type, 'Acorns helps you save & invest. Invest spare change, bank smarter, earn bonus investments, and more! Get started.', 'https://acorns.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Stash', broker_type, 'Simplified investing platform', 'https://stash.com', true, NOW(), NOW()),

    -- Crypto Exchanges
    (gen_random_uuid(), 'Coinbase', crypto_exchange_type, 'Cryptocurrency exchange platform', 'https://coinbase.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Binance', crypto_exchange_type, 'Global cryptocurrency exchange', 'https://binance.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Kraken', crypto_exchange_type, 'Cryptocurrency exchange and bank', 'https://kraken.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Gemini', crypto_exchange_type, 'Cryptocurrency exchange and custodian', 'https://gemini.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'FTX', crypto_exchange_type, 'Cryptocurrency exchange (now defunct)', 'https://ftx.com', false, NOW(), NOW()),
    (gen_random_uuid(), 'Crypto.com', crypto_exchange_type, 'Cryptocurrency platform and exchange', 'https://crypto.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'KuCoin', crypto_exchange_type, 'Global cryptocurrency exchange', 'https://kucoin.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Bitfinex', crypto_exchange_type, 'Cryptocurrency trading platform', 'https://bitfinex.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Bitstamp', crypto_exchange_type, 'European cryptocurrency exchange', 'https://bitstamp.net', true, NOW(), NOW()),
    (gen_random_uuid(), 'Huobi', crypto_exchange_type, 'Global cryptocurrency exchange', 'https://huobi.com', true, NOW(), NOW()),

    -- Blockchain Networks (for DeFi tracking)
    (gen_random_uuid(), 'Ethereum', crypto_wallet_type, 'Ethereum is a global, decentralized platform for money and new kinds of applications. On Ethereum, you can write code that controls money, and build applications accessible anywhere in the world.', 'https://ethereum.org', true, NOW(), NOW()),
    (gen_random_uuid(), 'Bitcoin', crypto_wallet_type, 'Bitcoin is an innovative payment network and a new kind of money. Find all you need to know and get started with Bitcoin on bitcoin.org.', 'https://bitcoin.org', true, NOW(), NOW()),
    (gen_random_uuid(), 'Polygon', crypto_wallet_type, 'Polygon is the fast, low', 'https://polygon.technology', true, NOW(), NOW()),
    (gen_random_uuid(), 'Binance Smart Chain', crypto_wallet_type, 'Binance blockchain network', 'https://binance.org', true, NOW(), NOW()),
    (gen_random_uuid(), 'Solana', crypto_wallet_type, 'Fast. Decentralized. Scalable. Energy efficient. Solana can power thousands of transactions per second.', 'https://solana.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Avax', crypto_wallet_type, 'Avalanche is a high', 'https://avax.network', true, NOW(), NOW()),
    (gen_random_uuid(), 'Arbitrum', crypto_wallet_type, 'Arbitrum: The ultimate Layer 2 scaling solution designed to enhance your Ethereum experience. Build faster, scale seamlessly, and unlock the full potential of the leading Layer 1 ecosystem.', 'https://arbitrum.io', true, NOW(), NOW()),
    (gen_random_uuid(), 'Optimism', crypto_wallet_type, 'Own your infrastructure. Grow your margins. The most used blockchain infrastructure. Launch scalable, customizable Layer 2s and apps with Ethereum', 'https://optimism.io', true, NOW(), NOW()),

    -- Fintech Payment Apps
    (gen_random_uuid(), 'Paypal', other_type, 'From paying friends to saving money or getting cash back when you shop, explore what the new PayPal app has to offer.', 'https://paypal.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Pay Friends', other_type, 'Mobile payment service owned by PayPal', 'https://venmo.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Cash App', other_type, 'Mobile payment service by Block (Square)', 'https://cash.app', true, NOW(), NOW()),
    (gen_random_uuid(), 'Zelle', other_type, 'Zelle enables individuals to electronically transfer money from their bank account to another registered user&#039;s bank account (within the United States) using a mobile device or the website of a participating banking institution.', 'https://zellepay.com', true, NOW(), NOW()),

    -- International Banks (Major ones)
    (gen_random_uuid(), 'HSBC Group', bank_type, 'HSBC, one of the largest banking and financial services institutions in the world, serves millions of customers through its four global businesses.', 'https://hsbc.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Barclays Group', bank_type, 'Barclays is a British universal bank. Our businesses include consumer banking, as well as a top', 'https://barclays.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Deutsche Bank', bank_type, 'Discover Deutsche Bank, one of the world’s leading financial services providers. News and Information about the bank and its products', 'https://db.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'UBS financial services in your location', bank_type, 'UBS is a global firm providing financial services in over 50 countries. Visit our site to find out what we offer in Indonesia.', 'https://ubs.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Banque BNP Paribas', bank_type, 'Toutes les informations sur BNP Paribas, banque internationale : offres d&#039;emploi, dirigeants, innovation, RSE, actualités, engagements, culture d&#039;entreprise...', 'https://bnpparibas.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Royal Bank of Canada', bank_type, 'Canadian multinational financial services company', 'https://rbc.com', true, NOW(), NOW()),

    -- Savings and Investment Apps
    (gen_random_uuid(), 'YOLO', broker_type, 'Social investing platform', 'https://yolo.investments', true, NOW(), NOW()),
    (gen_random_uuid(), 'Public', broker_type, 'Invest in Stocks, Bonds, Options, Crypto, ETFs, Treasuries, and more with AI', 'https://public.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'SoFi', broker_type, 'Personal finance and investing platform', 'https://sofi.com', true, NOW(), NOW()),

    -- EUROPE --
    
    -- United Kingdom
    (gen_random_uuid(), 'Lloyds', bank_type, 'Wherever you want to get to in life, Lloyds Bank has a range of bank accounts and personal banking services to suit you. Visit us today to find out more', 'https://lloydsbank.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'NatWest', bank_type, 'Welcome to NatWest. Our extensive personal banking products include bank accounts, mortgages, credit cards, loans and more. Visit today to see how we can serve you.', 'https://natwest.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Santander', bank_type, 'Welcome to Santander. We offer current accounts, savings, mortgages, loans, credit cards and much more. Here to help you prosper', 'https://santander.co.uk', true, NOW(), NOW()),
    (gen_random_uuid(), 'TSB', bank_type, 'At TSB we are here to help you make the most out of your money, so you can get more out of life. Whether you are looking for a new financial product or a smarter way to bank online, explore your options and see how we can help you today.', 'https://tsb.co.uk', true, NOW(), NOW()),
    (gen_random_uuid(), 'Nationwide', bank_type, 'Explore our range of mortgages, credit cards, savings, and bank accounts. Discover banking that is fairer, more rewarding and for the good of society', 'https://nationwide.co.uk', true, NOW(), NOW()),
    (gen_random_uuid(), 'Metro Bank', bank_type, 'Welcome to Metro Bank', 'https://metrobankonline.co.uk', true, NOW(), NOW()),
    (gen_random_uuid(), 'Starling Bank', bank_type, 'Transform the way you manage your money with Starling Bank. Enjoy personal and business banking online and at your fingertips, always. Apply in minutes.', 'https://starlingbank.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Monese', bank_type, 'Your banking alternative – manage your money the simple way with Monese. Open accounts in multiple currencies to spend abroad and transfer money.', 'https://monese.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Wise', bank_type, 'Banks charge a lot for overseas transfers. We don&#x27;t. Transfer money abroad easily and quickly with our low cost money transfers.', 'https://wise.com', true, NOW(), NOW()),

    -- Germany
    (gen_random_uuid(), 'Commerzbank', bank_type, 'Im Portal für Privat', 'https://commerzbank.de', true, NOW(), NOW()),
    (gen_random_uuid(), 'DZ BANK', bank_type, 'Learn more about the DZ BANK initiative in 1/2023: DZ BANK Group reports a profit before taxes of €1.95 billion. Inform yourself now!', 'https://dzbank.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'LBBW', bank_type, 'Regional verwurzelt, in der Welt zu Hause: Wohin der Weg auch f&uuml;hrt, die LBBW begleitet Sie und findet die beste L&ouml;sung. Wir wollen gemeinsam mit Ihnen Neues schaffen.', 'https://lbbw.de', true, NOW(), NOW()),
    (gen_random_uuid(), 'Volksbank', bank_type, 'German cooperative bank', 'https://volksbank.de', true, NOW(), NOW()),
    (gen_random_uuid(), 'Comdirect', bank_type, 'German direct bank', 'https://comdirect.de', true, NOW(), NOW()),

    -- Netherlands
    (gen_random_uuid(), 'ING', bank_type, 'Dutch multinational banking corporation', 'https://ing.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Abdamro', bank_type, 'Als bank leggen wij de focus op inclusiviteit, duurzaamheid, sociaal ondernemen, innovatie, dagelijkse bankzaken en meer.', 'https://abnamro.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Rabobank', bank_type, 'Dutch multinational banking corporation', 'https://rabobank.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'SNS Bank', bank_type, 'Heb je een product bij SNS en wil je iets wijzigen of ben je op zoek naar informatie? Hier vind je alle informatie over jouw SNS', 'https://snsbank.nl', true, NOW(), NOW()),
    (gen_random_uuid(), 'Bunq', bank_type, 'Discover a banking experience that fits your life. bunq offers hassle', 'https://bunq.com', true, NOW(), NOW()),

    -- Russia
    (gen_random_uuid(), 'Sberbank', bank_type, 'Russian state-owned banking giant', 'https://sberbank.ru', true, NOW(), NOW()),
    (gen_random_uuid(), 'VTB Bank', bank_type, 'Russian state-owned bank', 'https://vtb.ru', true, NOW(), NOW()),
    (gen_random_uuid(), 'Gazprombank', bank_type, 'Газпромбанк предлагает полный спектр банковских услуг для физических и юридических лиц: кредитование, вклады и депозиты, ведение счетов, инвестиции, дистанционные сервисы. Для получения дополнительной информации позвоните по телефону единой справочной службы Газпромбанка 8 (800) 100', 'https://gazprombank.ru', true, NOW(), NOW()),
    (gen_random_uuid(), 'Alfa-Bank', bank_type, 'Russian commercial bank', 'https://alfabank.ru', true, NOW(), NOW()),
    (gen_random_uuid(), 'T-Bank', bank_type, 'Лучший банк 2024 года по версии Банки.ру. Входит в топ', 'https://tinkoff.ru', true, NOW(), NOW()),

    -- Southeast Asia
    (gen_random_uuid(), 'DBS Bank', bank_type, 'Temukan kantor cabang DBS Indonesia terdekat dengan cepat dan mudah dan juga dapatkan informasi ATM , nomer telepon, alamat, jam operasional.', 'https://dbs.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'OCBC', bank_type, 'Discover a world of financial services with OCBC, the best trusted and established Singapore bank. Explore our range of banking solutions today.', 'https://ocbc.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'United Overseas Bank', bank_type, 'Singaporean bank', 'https://uob.com.sg', true, NOW(), NOW()),
    (gen_random_uuid(), 'Maybank', bank_type, 'Maybank Malaysia', 'https://maybank.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'CIMB Bank', bank_type, 'Malaysian bank', 'https://cimb.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Public Bank', bank_type, 'Malaysian bank', 'https://publicbank.com.my', true, NOW(), NOW()),
    (gen_random_uuid(), 'Bank Central Asia', bank_type, 'Indonesian bank', 'https://bca.co.id', true, NOW(), NOW()),
    (gen_random_uuid(), 'Bank Mandiri', bank_type, 'Indonesian bank', 'https://bankmandiri.co.id', true, NOW(), NOW()),
    (gen_random_uuid(), 'Bank Rakyat Indonesia', bank_type, 'Indonesian bank', 'https://bri.co.id', true, NOW(), NOW()),
    (gen_random_uuid(), 'Grab. Satu aplikasi semua bisa', other_type, 'Grab adalah superapp terdepan Asia Tenggara dengan layanan sehari&#x2d;hari seperti pengiriman, tranportasi, finansial, &#038; banyak lagi.', 'https://grab.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'GoPay', other_type, 'Temukan kemudahan transfer dan bayar dengan GoPay. Aplikasi ringan untuk transfer ke mana saja, langsung masuk, dan bebas biaya hingga 100x.', 'https://gopay.co.id', true, NOW(), NOW()),
    (gen_random_uuid(), 'OVO', other_type, 'Jadikan transaksi lebih simpel, instan, aman dan dapatkan berbagai keuntungan lainnya!', 'https://ovo.id', true, NOW(), NOW()),
    (gen_random_uuid(), 'DANA', other_type, 'Indonesian digital wallet', 'https://dana.id', true, NOW(), NOW()),
    (gen_random_uuid(), 'ShopeePay', other_type, 'Southeast Asian digital wallet by Shopee', 'https://shopee.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'TrueMoney', other_type, 'Thai digital wallet', 'https://truemoney.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'TouchNGo', other_type, 'Malaysian digital wallet', 'https://touchngo.com.my', true, NOW(), NOW()),
    (gen_random_uuid(), 'BigPay', other_type, 'Malaysian digital banking by AirAsia', 'https://bigpay.my', true, NOW(), NOW()),
    (gen_random_uuid(), 'Fave', other_type, 'Get Discounted Deals from Restaurants, Cafes, Bars, Spa, Salon, Gyms Near You. Get up to 70% discount on hundreds of deals in Malaysia & Singapore', 'https://myfave.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Sea', other_type, 'Sea Limited is a leading global consumer internet company founded in Singapore. Our mission is to better the lives of consumers and small businesses with technology. We operate three core businesses across digital entertainment, e', 'https://sea.com', true, NOW(), NOW()),

    -- Additional Crypto Exchanges & Platforms
    (gen_random_uuid(), 'OKX', crypto_exchange_type, 'Global cryptocurrency exchange', 'https://okx.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Bybit', crypto_exchange_type, 'Cryptocurrency derivatives exchange', 'https://bybit.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Gate.io', crypto_exchange_type, 'Global cryptocurrency exchange', 'https://gate.io', true, NOW(), NOW()),
    (gen_random_uuid(), 'Bitget', crypto_exchange_type, 'Cryptocurrency exchange and copy trading platform', 'https://bitget.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'MEXC', crypto_exchange_type, 'Global cryptocurrency exchange', 'https://mexc.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Coinex', crypto_exchange_type, 'Global cryptocurrency exchange', 'https://coinex.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Bitrue', crypto_exchange_type, 'Cryptocurrency exchange', 'https://bitrue.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'HTX', crypto_exchange_type, 'Global cryptocurrency exchange (formerly Huobi)', 'https://htx.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Poloniex', crypto_exchange_type, 'Cryptocurrency exchange', 'https://poloniex.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Bittrex Global', crypto_exchange_type, 'US-based cryptocurrency exchange', 'https://bittrex.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Upbit', crypto_exchange_type, 'South Korean cryptocurrency exchange', 'https://upbit.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Bithumb', crypto_exchange_type, 'South Korean cryptocurrency exchange', 'https://bithumb.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Coinone', crypto_exchange_type, 'South Korean cryptocurrency exchange', 'https://coinone.co.kr', true, NOW(), NOW()),
    (gen_random_uuid(), 'WazirX', crypto_exchange_type, 'Indian cryptocurrency exchange', 'https://wazirx.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'CoinDCX', crypto_exchange_type, 'Indian cryptocurrency exchange', 'https://coindcx.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Zebpay', crypto_exchange_type, 'Indian cryptocurrency exchange', 'https://zebpay.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Bitso', crypto_exchange_type, 'Mexican cryptocurrency exchange', 'https://bitso.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Mercado Bitcoin', crypto_exchange_type, 'Brazilian cryptocurrency exchange', 'https://mercadobitcoin.com.br', true, NOW(), NOW()),
    (gen_random_uuid(), 'Novadax', crypto_exchange_type, 'Brazilian cryptocurrency exchange', 'https://novadax.com.br', true, NOW(), NOW()),
    (gen_random_uuid(), 'Bitpanda', crypto_exchange_type, 'European cryptocurrency exchange', 'https://bitpanda.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Luno', crypto_exchange_type, 'Join millions buying, trading and storing Bitcoin, Ethereum and other cryptocurrencies on Luno. Invest today.', 'https://luno.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Paxful', crypto_exchange_type, 'Peer-to-peer cryptocurrency marketplace', 'https://paxful.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'LocalBitcoins', crypto_exchange_type, 'Peer-to-peer Bitcoin exchange', 'https://localbitcoins.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Deribit', crypto_exchange_type, 'Cryptocurrency derivatives exchange', 'https://deribit.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'FTX US', crypto_exchange_type, 'US arm of FTX (now defunct)', 'https://ftx.us', false, NOW(), NOW()),
    (gen_random_uuid(), 'Coinsquare', crypto_exchange_type, 'Coinsquare is Canada’s trusted platform to buy, sell, & trade Bitcoin, Ethereum, & more — access real', 'https://coinsquare.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Buy Bitcoin Canada', crypto_exchange_type, 'Join the Leading Regulated Cryptocurrency Marketplace in Canada. Low fees & top security at Bitbuy® when you buy Bitcoin, Ethereum & more. Start trading today!', 'https://bitbuy.ca', true, NOW(), NOW()),
    (gen_random_uuid(), 'CEX.IO', crypto_exchange_type, 'Cryptocurrency exchange', 'https://cex.io', true, NOW(), NOW()),
    (gen_random_uuid(), 'eToro', crypto_exchange_type, 'Social trading and multi-asset platform', 'https://etoro.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Plus500', crypto_exchange_type, 'CFD trading platform with crypto', 'https://plus500.com', true, NOW(), NOW()),

    -- DeFi Platforms & Protocols
    (gen_random_uuid(), 'Uniswap Interface', crypto_wallet_type, 'Swap crypto on Ethereum, Base, Arbitrum, Polygon, Unichain and more. The DeFi platform trusted by millions.', 'https://uniswap.org', true, NOW(), NOW()),
    (gen_random_uuid(), 'Swap', crypto_wallet_type, 'Trade crypto effortlessly with SushiSwap, supporting over 30 chains and featuring a powerful aggregator for the best rates across DeFi.', 'https://sushi.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'PancakeSwap', crypto_wallet_type, 'Trade, earn, and own crypto on the all', 'https://pancakeswap.finance', true, NOW(), NOW()),
    (gen_random_uuid(), 'Compound', crypto_wallet_type, 'Compound is an algorithmic, autonomous interest rate protocol built for developers, to unlock a universe of open financial applications.', 'https://compound.finance', true, NOW(), NOW()),
    (gen_random_uuid(), 'Aave', crypto_wallet_type, 'Decentralized lending and borrowing protocol', 'https://aave.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'MakerDAO', crypto_wallet_type, 'Decentralized autonomous organization and lending protocol', 'https://makerdao.com', true, NOW(), NOW()),
    (gen_random_uuid(), 'Curve.finance', crypto_wallet_type, 'Curve', 'https://curve.fi', true, NOW(), NOW()),
    (gen_random_uuid(), 'Balancer', crypto_wallet_type, 'Automated portfolio manager and trading platform', 'https://balancer.fi', true, NOW(), NOW()),
    (gen_random_uuid(), 'Yearn', crypto_wallet_type, 'The yield protocol for digital assets', 'https://yearn.finance', true, NOW(), NOW()),
    (gen_random_uuid(), 'Convex', crypto_wallet_type, 'A platform that boosts rewards for users of Curve, Prisma, Frax, and f(x) Protocol', 'https://convexfinance.com', true, NOW(), NOW()),

    -- Additional Blockchain Networks
    (gen_random_uuid(), 'Cardano', crypto_wallet_type, 'Proof-of-stake blockchain platform', 'https://cardano.org', true, NOW(), NOW()),
    (gen_random_uuid(), 'Polkadot', crypto_wallet_type, 'Defy the possibilities with Polkadot’s interoperable multi', 'https://polkadot.network', true, NOW(), NOW()),
    (gen_random_uuid(), 'Algorand', crypto_wallet_type, 'Pure proof-of-stake blockchain', 'https://algorand.com', true, NOW(), NOW());

END $$;