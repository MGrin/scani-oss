-- Seed institution_blockchain_mappings for every blockchain institution seeded
-- by 0003_seed_institutions.sql + 0004_seed_evm_chains.sql.
--
-- Why: without a mapping row, IntegrationManager.detectWalletInstitutions
-- returns [] for that chain — which is exactly the bug that made wallet
-- imports land as "0 holdings across 0 accounts / No chains were detected".
-- Prior to this migration only the TON row existed (see 0004).
--
-- The upsert key is (institution_id), which is UNIQUE on the table. We look
-- each institution up by website (the idempotent key used by the seed
-- migrations); anything missing is silently skipped so this migration is
-- safe to re-run against partial states.

INSERT INTO institution_blockchain_mappings (institution_id, chain_id, chain_type, is_active)
SELECT i.id, m.chain_id, m.chain_type, true
FROM institutions i
JOIN (VALUES
    ('https://bitcoin.org',                         '0',      'bitcoin'),
    ('https://solana.com',                          '-2',     'solana'),
    ('https://tron.network',                        '-1',     'tron'),
    ('https://ethereum.org',                        '1',      'evm'),
    ('https://www.bnbchain.org',                    '56',     'evm'),
    ('https://polygon.technology',                  '137',    'evm'),
    ('https://www.avax.network',                    '43114',  'evm'),
    ('https://arbitrum.io',                         '42161',  'evm'),
    ('https://www.optimism.io',                     '10',     'evm'),
    ('https://base.org',                            '8453',   'evm'),
    ('https://fantom.foundation',                   '250',    'evm'),
    ('https://cronos.org',                          '25',     'evm'),
    ('https://nova.arbitrum.io',                    '42170',  'evm'),
    ('https://zksync.io',                           '324',    'evm'),
    ('https://scroll.io',                           '534352', 'evm'),
    ('https://linea.build',                         '59144',  'evm'),
    ('https://blast.io',                            '81457',  'evm'),
    ('https://mantle.xyz',                          '5000',   'evm'),
    ('https://opbnb.bnbchain.org',                  '204',    'evm'),
    ('https://gnosis.io',                           '100',    'evm'),
    ('https://celo.org',                            '42220',  'evm'),
    ('https://moonbeam.network',                    '1284',   'evm'),
    ('https://moonbeam.network/networks/moonriver', '1285',   'evm'),
    ('https://frax.com',                            '252',    'evm'),
    ('https://roninchain.com',                      '747474', 'evm'),
    ('https://xdc.org',                             '50',     'evm'),
    ('https://bt.io',                               '199',    'evm'),
    ('https://berachain.com',                       '80094',  'evm'),
    ('https://sei.io',                              '1329',   'evm'),
    ('https://soniclabs.com',                       '146',    'evm'),
    ('https://sophon.xyz',                          '50104',  'evm'),
    ('https://swellnetwork.io',                     '1923',   'evm'),
    ('https://taiko.xyz',                           '167000', 'evm'),
    ('https://unichain.org',                        '130',    'evm'),
    ('https://worldcoin.org/world-chain',           '480',    'evm'),
    ('https://abstract.xyz',                        '2741',   'evm'),
    ('https://apechain.com',                        '33139',  'evm'),
    ('https://hyperevm.com',                        '999',    'evm')
) AS m(website, chain_id, chain_type) ON i.website = m.website
ON CONFLICT (institution_id) DO UPDATE
  SET chain_id = EXCLUDED.chain_id,
      chain_type = EXCLUDED.chain_type,
      is_active = true,
      updated_at = now();
