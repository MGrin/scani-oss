-- 20261017080003 — migration archive tables go with the rows they copied
--
-- Two repair migrations kept the prior state of a user's ledger in archive
-- tables with no foreign key (SC-1753): `_sc357_solana_rekey_20260817` holds a
-- holding's quantities, dates and external ids, `_sc328_kraken_eth_pairs_20260817`
-- holds ledger row ids and their prior review state. Deleting an account, or
-- "delete all my data", removed the holdings and left these rows standing.
-- Measured on production 2026-10-17: 474 and 11 rows, none orphaned yet.
--
-- Each archive row now cascades from the row it copied, so whatever deletes
-- that row deletes its archive copy in the same transaction. Orphans are
-- removed first, because the constraint cannot be added over them.
DELETE FROM "_sc357_solana_rekey_20260817" a
WHERE NOT EXISTS (SELECT 1 FROM holdings h WHERE h.id = a.holding_id);

ALTER TABLE "_sc357_solana_rekey_20260817"
  ADD CONSTRAINT "_sc357_solana_rekey_20260817_holding_id_fk"
  FOREIGN KEY ("holding_id") REFERENCES holdings ("id") ON DELETE CASCADE;

DELETE FROM "_sc328_kraken_eth_pairs_20260817" p
WHERE NOT EXISTS (SELECT 1 FROM holding_transactions t WHERE t.id = p.outflow_id)
   OR NOT EXISTS (SELECT 1 FROM holding_transactions t WHERE t.id = p.inflow_id);

ALTER TABLE "_sc328_kraken_eth_pairs_20260817"
  ADD CONSTRAINT "_sc328_kraken_eth_pairs_20260817_outflow_id_fk"
  FOREIGN KEY ("outflow_id") REFERENCES holding_transactions ("id") ON DELETE CASCADE;

ALTER TABLE "_sc328_kraken_eth_pairs_20260817"
  ADD CONSTRAINT "_sc328_kraken_eth_pairs_20260817_inflow_id_fk"
  FOREIGN KEY ("inflow_id") REFERENCES holding_transactions ("id") ON DELETE CASCADE;
