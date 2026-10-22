-- 20261021192703 — litecoin-wallet-chain-mapping
-- Add the seeded Litecoin institution to the same chain-resolution map
-- used by wallet imports and transaction syncs.
INSERT INTO institution_blockchain_mappings (institution_id, chain_id, chain_type, is_active)
SELECT i.id, '-3', 'litecoin', true
FROM institutions i
WHERE i.website = 'https://litecoin.org'
ON CONFLICT (institution_id) DO UPDATE
SET chain_id = EXCLUDED.chain_id,
    chain_type = EXCLUDED.chain_type,
    is_active = EXCLUDED.is_active;
