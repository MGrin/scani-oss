-- Custom SQL migration file, put your code below! --

-- Seed EVM chains from Etherscan supported chains list
-- Only mainnet chains, testnets excluded for production use

-- Get the crypto_wallet institution type ID
DO $$
DECLARE
    v_crypto_wallet_type_id uuid;
BEGIN
    -- Get crypto_wallet type ID
    SELECT id INTO v_crypto_wallet_type_id FROM institution_types WHERE code = 'crypto_wallet';

    -- Insert new EVM chains that don't exist yet
    -- Using ON CONFLICT to safely handle if any chains already exist

    -- Ethereum Mainnet (should already exist, but included for completeness)
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('Ethereum', v_crypto_wallet_type_id, 'Decentralized blockchain platform supporting smart contracts and dApps (Chain ID: 1)', 'https://ethereum.org', true)
    ON CONFLICT (website) DO NOTHING;

    -- Abstract Mainnet
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('Abstract', v_crypto_wallet_type_id, 'Abstract blockchain network (Chain ID: 2741)', 'https://abstract.xyz', true)
    ON CONFLICT (website) DO NOTHING;

    -- ApeChain Mainnet
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('ApeChain', v_crypto_wallet_type_id, 'ApeChain blockchain network (Chain ID: 33139)', 'https://apechain.com', true)
    ON CONFLICT (website) DO NOTHING;

    -- Arbitrum Nova Mainnet
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('Arbitrum Nova', v_crypto_wallet_type_id, 'Layer-2 scaling solution for gaming and social applications (Chain ID: 42170)', 'https://nova.arbitrum.io', true)
    ON CONFLICT (website) DO NOTHING;

    -- Arbitrum One (should already exist)
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('Arbitrum', v_crypto_wallet_type_id, 'Layer-2 scaling solution for Ethereum using optimistic rollups (Chain ID: 42161)', 'https://arbitrum.io', true)
    ON CONFLICT (website) DO NOTHING;

    -- Avalanche C-Chain (should already exist)
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('Avalanche', v_crypto_wallet_type_id, 'Platform for decentralized applications and custom blockchain networks (Chain ID: 43114)', 'https://www.avax.network', true)
    ON CONFLICT (website) DO NOTHING;

    -- Base Mainnet (should already exist)
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('Base', v_crypto_wallet_type_id, 'Layer-2 blockchain built on Ethereum by Coinbase (Chain ID: 8453)', 'https://base.org', true)
    ON CONFLICT (website) DO NOTHING;

    -- Berachain Mainnet
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('Berachain', v_crypto_wallet_type_id, 'EVM-identical Layer 1 blockchain (Chain ID: 80094)', 'https://berachain.com', true)
    ON CONFLICT (website) DO NOTHING;

    -- BitTorrent Chain Mainnet
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('BitTorrent Chain', v_crypto_wallet_type_id, 'Cross-chain scaling solution (Chain ID: 199)', 'https://bt.io', true)
    ON CONFLICT (website) DO NOTHING;

    -- Blast Mainnet
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('Blast', v_crypto_wallet_type_id, 'Ethereum Layer 2 with native yield (Chain ID: 81457)', 'https://blast.io', true)
    ON CONFLICT (website) DO NOTHING;

    -- BNB Smart Chain (should already exist)
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('Binance Smart Chain', v_crypto_wallet_type_id, 'Blockchain network with smart contract functionality (Chain ID: 56)', 'https://www.bnbchain.org', true)
    ON CONFLICT (website) DO NOTHING;

    -- Celo Mainnet
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('Celo', v_crypto_wallet_type_id, 'Mobile-first blockchain platform (Chain ID: 42220)', 'https://celo.org', true)
    ON CONFLICT (website) DO NOTHING;

    -- Cronos Mainnet (should already exist)
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('Cronos', v_crypto_wallet_type_id, 'EVM-compatible blockchain built on Cosmos SDK by Crypto.com (Chain ID: 25)', 'https://cronos.org', true)
    ON CONFLICT (website) DO NOTHING;

    -- Fraxtal Mainnet
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('Fraxtal', v_crypto_wallet_type_id, 'Layer 2 blockchain by Frax Finance (Chain ID: 252)', 'https://frax.com', true)
    ON CONFLICT (website) DO NOTHING;

    -- Gnosis Chain
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('Gnosis', v_crypto_wallet_type_id, 'EVM-compatible blockchain focused on payments and identity (Chain ID: 100)', 'https://gnosis.io', true)
    ON CONFLICT (website) DO NOTHING;

    -- HyperEVM Mainnet
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('HyperEVM', v_crypto_wallet_type_id, 'High-performance EVM blockchain (Chain ID: 999)', 'https://hyperevm.com', true)
    ON CONFLICT (website) DO NOTHING;

    -- Linea Mainnet
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('Linea', v_crypto_wallet_type_id, 'zkEVM Layer 2 network by ConsenSys (Chain ID: 59144)', 'https://linea.build', true)
    ON CONFLICT (website) DO NOTHING;

    -- Mantle Mainnet
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('Mantle', v_crypto_wallet_type_id, 'Layer 2 scaling solution with modular architecture (Chain ID: 5000)', 'https://mantle.xyz', true)
    ON CONFLICT (website) DO NOTHING;

    -- Moonbeam Mainnet (should already exist)
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('Moonbeam', v_crypto_wallet_type_id, 'Ethereum-compatible smart contract platform on Polkadot (Chain ID: 1284)', 'https://moonbeam.network', true)
    ON CONFLICT (website) DO NOTHING;

    -- Moonriver Mainnet (should already exist)
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('Moonriver', v_crypto_wallet_type_id, 'Ethereum-compatible smart contract platform on Kusama (Chain ID: 1285)', 'https://moonbeam.network/networks/moonriver', true)
    ON CONFLICT (website) DO NOTHING;

    -- OP Mainnet (Optimism - should already exist)
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('Optimism', v_crypto_wallet_type_id, 'Layer-2 scaling solution for Ethereum providing faster and cheaper transactions (Chain ID: 10)', 'https://www.optimism.io', true)
    ON CONFLICT (website) DO NOTHING;

    -- Polygon Mainnet (should already exist)
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('Polygon', v_crypto_wallet_type_id, 'Layer-2 scaling solution for Ethereum providing faster and cheaper transactions (Chain ID: 137)', 'https://polygon.technology', true)
    ON CONFLICT (website) DO NOTHING;

    -- Katana Mainnet (Ronin)
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('Ronin', v_crypto_wallet_type_id, 'Ethereum sidechain for gaming (Chain ID: 747474)', 'https://roninchain.com', true)
    ON CONFLICT (website) DO NOTHING;

    -- Sei Mainnet
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('Sei', v_crypto_wallet_type_id, 'Layer 1 blockchain optimized for trading (Chain ID: 1329)', 'https://sei.io', true)
    ON CONFLICT (website) DO NOTHING;

    -- Scroll Mainnet
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('Scroll', v_crypto_wallet_type_id, 'zkEVM Layer 2 scaling solution (Chain ID: 534352)', 'https://scroll.io', true)
    ON CONFLICT (website) DO NOTHING;

    -- Sonic Mainnet
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('Sonic', v_crypto_wallet_type_id, 'High-performance blockchain network (Chain ID: 146)', 'https://soniclabs.com', true)
    ON CONFLICT (website) DO NOTHING;

    -- Sophon Mainnet
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('Sophon', v_crypto_wallet_type_id, 'zkSync-based entertainment blockchain (Chain ID: 50104)', 'https://sophon.xyz', true)
    ON CONFLICT (website) DO NOTHING;

    -- Swellchain Mainnet
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('Swellchain', v_crypto_wallet_type_id, 'Layer 2 blockchain for liquid staking (Chain ID: 1923)', 'https://swellnetwork.io', true)
    ON CONFLICT (website) DO NOTHING;

    -- Taiko Mainnet
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('Taiko', v_crypto_wallet_type_id, 'Decentralized zkEVM rollup (Chain ID: 167000)', 'https://taiko.xyz', true)
    ON CONFLICT (website) DO NOTHING;

    -- Unichain Mainnet
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('Unichain', v_crypto_wallet_type_id, 'DeFi-focused Layer 2 by Uniswap (Chain ID: 130)', 'https://unichain.org', true)
    ON CONFLICT (website) DO NOTHING;

    -- World Mainnet
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('World Chain', v_crypto_wallet_type_id, 'Optimism Superchain for verified humans (Chain ID: 480)', 'https://worldcoin.org/world-chain', true)
    ON CONFLICT (website) DO NOTHING;

    -- XDC Mainnet
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('XDC Network', v_crypto_wallet_type_id, 'Enterprise-ready hybrid blockchain (Chain ID: 50)', 'https://xdc.org', true)
    ON CONFLICT (website) DO NOTHING;

    -- zkSync Mainnet
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('zkSync Era', v_crypto_wallet_type_id, 'zkEVM Layer 2 scaling solution (Chain ID: 324)', 'https://zksync.io', true)
    ON CONFLICT (website) DO NOTHING;

    -- opBNB Mainnet
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('opBNB', v_crypto_wallet_type_id, 'Layer 2 scaling solution for BNB Chain (Chain ID: 204)', 'https://opbnb.bnbchain.org', true)
    ON CONFLICT (website) DO NOTHING;

    -- Fantom (should already exist)
    INSERT INTO institutions (name, type_id, description, website, is_active)
    VALUES ('Fantom', v_crypto_wallet_type_id, 'High-performance, scalable, and secure smart contract platform (Chain ID: 250)', 'https://fantom.foundation', true)
    ON CONFLICT (website) DO NOTHING;

END $$;