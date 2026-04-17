-- Seed EVM chains (and TON) as institutions, then mark them integration-ready.
-- Institutions are keyed by website for idempotent seeding.

DO $$
DECLARE
    v_crypto_wallet_type_id uuid;
    v_ton_institution_id uuid;
BEGIN
    SELECT id INTO v_crypto_wallet_type_id FROM institution_types WHERE code = 'crypto_wallet';

    INSERT INTO institutions (name, type_id, description, website, is_active) VALUES
      ('Ethereum',            v_crypto_wallet_type_id, 'Decentralized blockchain platform supporting smart contracts and dApps (Chain ID: 1)',           'https://ethereum.org',                          true),
      ('Abstract',            v_crypto_wallet_type_id, 'Abstract blockchain network (Chain ID: 2741)',                                                   'https://abstract.xyz',                          true),
      ('ApeChain',            v_crypto_wallet_type_id, 'ApeChain blockchain network (Chain ID: 33139)',                                                  'https://apechain.com',                          true),
      ('Arbitrum Nova',       v_crypto_wallet_type_id, 'Layer-2 scaling solution for gaming and social applications (Chain ID: 42170)',                  'https://nova.arbitrum.io',                      true),
      ('Arbitrum',            v_crypto_wallet_type_id, 'Layer-2 scaling solution for Ethereum using optimistic rollups (Chain ID: 42161)',               'https://arbitrum.io',                           true),
      ('Avalanche',           v_crypto_wallet_type_id, 'Platform for decentralized applications and custom blockchain networks (Chain ID: 43114)',       'https://www.avax.network',                      true),
      ('Base',                v_crypto_wallet_type_id, 'Layer-2 blockchain built on Ethereum by Coinbase (Chain ID: 8453)',                              'https://base.org',                              true),
      ('Berachain',           v_crypto_wallet_type_id, 'EVM-identical Layer 1 blockchain (Chain ID: 80094)',                                             'https://berachain.com',                         true),
      ('BitTorrent Chain',    v_crypto_wallet_type_id, 'Cross-chain scaling solution (Chain ID: 199)',                                                   'https://bt.io',                                 true),
      ('Blast',               v_crypto_wallet_type_id, 'Ethereum Layer 2 with native yield (Chain ID: 81457)',                                           'https://blast.io',                              true),
      ('Binance Smart Chain', v_crypto_wallet_type_id, 'Blockchain network with smart contract functionality (Chain ID: 56)',                            'https://www.bnbchain.org',                      true),
      ('Celo',                v_crypto_wallet_type_id, 'Mobile-first blockchain platform (Chain ID: 42220)',                                             'https://celo.org',                              true),
      ('Cronos',              v_crypto_wallet_type_id, 'EVM-compatible blockchain built on Cosmos SDK by Crypto.com (Chain ID: 25)',                     'https://cronos.org',                            true),
      ('Fantom',              v_crypto_wallet_type_id, 'High-performance, scalable, and secure smart contract platform (Chain ID: 250)',                 'https://fantom.foundation',                     true),
      ('Fraxtal',             v_crypto_wallet_type_id, 'Layer 2 blockchain by Frax Finance (Chain ID: 252)',                                             'https://frax.com',                              true),
      ('Gnosis',              v_crypto_wallet_type_id, 'EVM-compatible blockchain focused on payments and identity (Chain ID: 100)',                     'https://gnosis.io',                             true),
      ('HyperEVM',            v_crypto_wallet_type_id, 'High-performance EVM blockchain (Chain ID: 999)',                                                'https://hyperevm.com',                          true),
      ('Linea',               v_crypto_wallet_type_id, 'zkEVM Layer 2 network by ConsenSys (Chain ID: 59144)',                                           'https://linea.build',                           true),
      ('Mantle',              v_crypto_wallet_type_id, 'Layer 2 scaling solution with modular architecture (Chain ID: 5000)',                            'https://mantle.xyz',                            true),
      ('Moonbeam',            v_crypto_wallet_type_id, 'Ethereum-compatible smart contract platform on Polkadot (Chain ID: 1284)',                       'https://moonbeam.network',                      true),
      ('Moonriver',           v_crypto_wallet_type_id, 'Ethereum-compatible smart contract platform on Kusama (Chain ID: 1285)',                         'https://moonbeam.network/networks/moonriver',   true),
      ('Optimism',            v_crypto_wallet_type_id, 'Layer-2 scaling solution for Ethereum providing faster and cheaper transactions (Chain ID: 10)', 'https://www.optimism.io',                       true),
      ('Polygon',             v_crypto_wallet_type_id, 'Layer-2 scaling solution for Ethereum (Chain ID: 137)',                                          'https://polygon.technology',                    true),
      ('Ronin',               v_crypto_wallet_type_id, 'Ethereum sidechain for gaming (Chain ID: 747474)',                                               'https://roninchain.com',                        true),
      ('Sei',                 v_crypto_wallet_type_id, 'Layer 1 blockchain optimized for trading (Chain ID: 1329)',                                      'https://sei.io',                                true),
      ('Scroll',              v_crypto_wallet_type_id, 'zkEVM Layer 2 scaling solution (Chain ID: 534352)',                                              'https://scroll.io',                             true),
      ('Sonic',               v_crypto_wallet_type_id, 'High-performance blockchain network (Chain ID: 146)',                                            'https://soniclabs.com',                         true),
      ('Sophon',              v_crypto_wallet_type_id, 'zkSync-based entertainment blockchain (Chain ID: 50104)',                                        'https://sophon.xyz',                            true),
      ('Swellchain',          v_crypto_wallet_type_id, 'Layer 2 blockchain for liquid staking (Chain ID: 1923)',                                         'https://swellnetwork.io',                       true),
      ('Taiko',               v_crypto_wallet_type_id, 'Decentralized zkEVM rollup (Chain ID: 167000)',                                                  'https://taiko.xyz',                             true),
      ('Unichain',            v_crypto_wallet_type_id, 'DeFi-focused Layer 2 by Uniswap (Chain ID: 130)',                                                'https://unichain.org',                          true),
      ('World Chain',         v_crypto_wallet_type_id, 'Optimism Superchain for verified humans (Chain ID: 480)',                                        'https://worldcoin.org/world-chain',             true),
      ('XDC Network',         v_crypto_wallet_type_id, 'Enterprise-ready hybrid blockchain (Chain ID: 50)',                                              'https://xdc.org',                               true),
      ('zkSync Era',          v_crypto_wallet_type_id, 'zkEVM Layer 2 scaling solution (Chain ID: 324)',                                                 'https://zksync.io',                             true),
      ('opBNB',               v_crypto_wallet_type_id, 'Layer 2 scaling solution for BNB Chain (Chain ID: 204)',                                         'https://opbnb.bnbchain.org',                    true),
      ('TON',                 v_crypto_wallet_type_id, 'The Open Network - Layer-1 blockchain designed for mass adoption',                               'https://ton.org',                               true)
    ON CONFLICT (website) DO NOTHING;

    -- TON uses a non-EVM mapping (chain_id -15). Other chains get their mappings
    -- registered at runtime by IntegrationManager.
    SELECT id INTO v_ton_institution_id FROM institutions WHERE website = 'https://ton.org';
    IF v_ton_institution_id IS NOT NULL THEN
      INSERT INTO institution_blockchain_mappings (institution_id, chain_id, chain_type, is_active)
      VALUES (v_ton_institution_id, '-15', 'ton', true)
      ON CONFLICT (institution_id) DO NOTHING;
    END IF;

    -- Mark every seeded blockchain institution as integration-ready.
    UPDATE institutions SET has_integration = true
    WHERE website IN (
      'https://ethereum.org', 'https://abstract.xyz', 'https://apechain.com',
      'https://nova.arbitrum.io', 'https://arbitrum.io', 'https://www.avax.network',
      'https://base.org', 'https://berachain.com', 'https://bt.io', 'https://blast.io',
      'https://www.bnbchain.org', 'https://celo.org', 'https://cronos.org',
      'https://fantom.foundation', 'https://frax.com', 'https://gnosis.io',
      'https://hyperevm.com', 'https://linea.build', 'https://mantle.xyz',
      'https://moonbeam.network', 'https://moonbeam.network/networks/moonriver',
      'https://www.optimism.io', 'https://polygon.technology', 'https://roninchain.com',
      'https://sei.io', 'https://scroll.io', 'https://soniclabs.com', 'https://sophon.xyz',
      'https://swellnetwork.io', 'https://taiko.xyz', 'https://unichain.org',
      'https://worldcoin.org/world-chain', 'https://xdc.org', 'https://zksync.io',
      'https://opbnb.bnbchain.org', 'https://ton.org'
    );
END $$;
