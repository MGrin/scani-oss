-- SC-331. The EVM ledger holds 500 `etherscan` transaction rows describing
-- 281 on-chain events. 219 of those rows are copies of an event booked onto an
-- account that was never party to it, and most of the copies carry
-- `transfer_review = 'left_control'`, which is the one answer that books a
-- disposal. This migration reduces the population to one row per event, on the
-- account the chain says was involved.
--
-- THE WRITER, fixed in the same PR. `user_integration_credentials` is
-- UNIQUE (user_id, institution_id), so a user with three Ethereum wallets has
-- exactly ONE Ethereum credential holding ONE address.
-- `TransactionImportCoordinator` resolved a wallet import's address from that
-- row, so every Ethereum account imported whichever address won it. The
-- balance path never had the bug: `SyncWalletBalancesUseCase.makeProviderCtx`
-- synthesizes the credential from the wallet's own address. The coordinator
-- now does the same, from `accounts.metadata.walletAddress`, and refuses to
-- run when that is absent rather than falling back.
--
-- THE EVIDENCE, measured read-only against production 2026-08-17.
--
--   * One wallet is party to EVERY etherscan row: `from` on every outflow,
--     `to` on every inflow. Not one exception. Every row therefore describes that wallet,
--     and belongs on ITS account for the row's chain.
--   * The rows sit on nine accounts spanning three wallets and five chains.
--     0xb0b1...a8b9 and 0xc0ff...ff01 never sent or received any of them;
--     their own history was never fetched, because their credential lost.
--   * Placement, by whether the account was actually involved: a large
--     majority of both the outflow and the inflow rows sit on an account that
--     was NEITHER the sender nor the recipient.
--   * Grouping by (tx hash, chain, token, kind) collapses them to far fewer
--     events, and NO event has more than one row on the involved account. Most
--     outflow events are booked three times, the rest twice.
--   * The uninvolved outflow rows carry a material amount of ETH and almost as
--     many unattributed `left_control` answers. `isConfirmedDisposal` realizes
--     per ROW, so one ETH transfer booked on three accounts realized three
--     disposals — which is why SC-324's realized figure and SC-302's "left the
--     portfolio" quantity are both inflated.
--
-- WHY DELETION AND NOT RE-ANSWERING. A `transfer_review` answer is a claim
-- about a transaction. A row that should not exist has no correct answer:
-- `internal`, `left_control` and `paired` are all wrong about it. No row kept
-- here has its review touched — whether those answers are right is SC-302 and
-- SC-328, and a different question from whether the row should exist.
--
-- WHY SOME ROWS MOVE INSTEAD OF DYING. Fewer outflow rows sit on the sending
-- account than there are outflow events: a minority of outflow events and a
-- handful of inflow events have NO row on the involved account at all, only
-- copies elsewhere. Deleting "the copies" would delete those events outright. They
-- exist only elsewhere because the router is FIND-ONLY for wallet sources
-- (`isWalletDerivedSource`) — the token had no holding on the correct account,
-- so the event could only land where one existed. Every row that moves is USDC
-- or WETH; every ETH, MATIC, SAND, CODE and STETH event already has its row in
-- the right place, so nothing that moves here carries material realized PnL.
--
-- WHY TWO HOLDINGS ARE CREATED. Most of the rows that move have no holding on
-- the target account to move to. Neither target appears in `holding_exclusions` — the
-- user did not reject them at wallet review; they hold nothing today, so the
-- review never offered them. Both are created with balance 0, which is what
-- the chain says they hold. The alternative was deleting real events.
--
-- REVERSIBILITY. Every one of the 219 deleted rows is a field-for-field
-- duplicate of the row that survives its event — same quantity, same
-- occurred_at, same external_id, same token, verified for all 219. A restore
-- therefore needs only the (id, holding_id) pairs named below plus the
-- surviving row's remaining columns; no information exists in a deleted row
-- that is not also in its survivor. The 47 moved rows are restored by setting
-- `holding_id` back to the value named beside each.
--
-- SHAPE. Every statement below is scoped to named ids, so on a database that
-- does not hold this population — a fresh dev box, CI's Postgres container —
-- each one matches nothing and the migration is a no-op. The assertions are
-- written the same way: they fire on a population that has DRIFTED from what
-- was measured, and stay quiet on one that was never there. A migration that
-- hard-failed on an empty database would break every CI run (0044 is
-- data-driven for the same reason).

BEGIN;

-- Preconditions. Facts the id lists below were derived from. `0` means this
-- database simply has no EVM ledger and everything after this is a no-op;
-- anything other than 0 or 500 means the population moved after it was
-- measured, and the ids can no longer be trusted.
DO $$
DECLARE n integer; bad integer;
BEGIN
  SELECT count(*) INTO n FROM holding_transactions WHERE source = 'etherscan';
  IF n = 0 THEN
    RAISE NOTICE 'SC-331: no etherscan rows here; migration is a no-op';
    RETURN;
  END IF;
  IF n <> 500 THEN
    RAISE EXCEPTION 'SC-331: expected 500 etherscan rows, found % — the ids in this migration are stale', n;
  END IF;

  SELECT count(*) INTO bad FROM holding_transactions
   WHERE source = 'etherscan'
     AND lower(raw_payload->>'from') IS DISTINCT FROM '0xa11ce0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7'
     AND lower(raw_payload->>'to')   IS DISTINCT FROM '0xa11ce0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7';
  IF bad <> 0 THEN
    RAISE EXCEPTION 'SC-331: % etherscan rows do not involve 0xa11c...a6b7; the premise that every row describes that one wallet no longer holds', bad;
  END IF;
END $$;


-- The two holdings the moved rows need, created only where the account and
-- token they hang off actually exist — so this inserts nothing on a database
-- without this user's wallets, rather than failing a foreign key.
INSERT INTO holdings (id, user_id, account_id, token_id, balance, source, external_id, is_hidden, is_active, arrival)
SELECT '5c331000-0000-4331-8000-000000000001', '5c331000-0000-4331-8000-000000000003', '5c331000-0000-4331-8000-000000000004', '5c331000-0000-4331-8000-000000000005', '0', 'etherscan', '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', false, true, 'unattributed'
 WHERE EXISTS (SELECT 1 FROM accounts WHERE id = '5c331000-0000-4331-8000-000000000004')
   AND EXISTS (SELECT 1 FROM tokens   WHERE id = '5c331000-0000-4331-8000-000000000005')
ON CONFLICT DO NOTHING;  -- Polygon / USDC
INSERT INTO holdings (id, user_id, account_id, token_id, balance, source, external_id, is_hidden, is_active, arrival)
SELECT '5c331000-0000-4331-8000-000000000002', '5c331000-0000-4331-8000-000000000003', '5c331000-0000-4331-8000-000000000006', '5c331000-0000-4331-8000-000000000007', '0', 'etherscan', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', false, true, 'unattributed'
 WHERE EXISTS (SELECT 1 FROM accounts WHERE id = '5c331000-0000-4331-8000-000000000006')
   AND EXISTS (SELECT 1 FROM tokens   WHERE id = '5c331000-0000-4331-8000-000000000007')
ON CONFLICT DO NOTHING;  -- Ethereum / WETH

-- Move the rows whose event has no row at all on the account that made it. Without this they would be deleted as "copies" and the event lost.
-- Ethereum / USDC — rows off an uninvolved account
UPDATE holding_transactions SET holding_id = '5c331000-0000-4331-8000-000000000008'
 WHERE id IN (
    '5c331000-0000-4331-8001-000000000001', '5c331000-0000-4331-8001-000000000002', '5c331000-0000-4331-8001-000000000003',
    '5c331000-0000-4331-8001-000000000004', '5c331000-0000-4331-8001-000000000005', '5c331000-0000-4331-8001-000000000006',
    '5c331000-0000-4331-8001-000000000007', '5c331000-0000-4331-8001-000000000008', '5c331000-0000-4331-8001-000000000009',
    '5c331000-0000-4331-8001-000000000010', '5c331000-0000-4331-8001-000000000011', '5c331000-0000-4331-8001-000000000012',
    '5c331000-0000-4331-8001-000000000013'
 );
-- Base / USDC — rows off an uninvolved account
UPDATE holding_transactions SET holding_id = '5c331000-0000-4331-8000-000000000009'
 WHERE id IN (
    '5c331000-0000-4331-8001-000000000014', '5c331000-0000-4331-8001-000000000015', '5c331000-0000-4331-8001-000000000016',
    '5c331000-0000-4331-8001-000000000017', '5c331000-0000-4331-8001-000000000018', '5c331000-0000-4331-8001-000000000019'
 );
-- Polygon / USDC — rows into the holding created above
UPDATE holding_transactions SET holding_id = '5c331000-0000-4331-8000-000000000001'
 WHERE id IN (
    '5c331000-0000-4331-8001-000000000020', '5c331000-0000-4331-8001-000000000021', '5c331000-0000-4331-8001-000000000022',
    '5c331000-0000-4331-8001-000000000023', '5c331000-0000-4331-8001-000000000024', '5c331000-0000-4331-8001-000000000025',
    '5c331000-0000-4331-8001-000000000026', '5c331000-0000-4331-8001-000000000027', '5c331000-0000-4331-8001-000000000028',
    '5c331000-0000-4331-8001-000000000029', '5c331000-0000-4331-8001-000000000030', '5c331000-0000-4331-8001-000000000031',
    '5c331000-0000-4331-8001-000000000032', '5c331000-0000-4331-8001-000000000033', '5c331000-0000-4331-8001-000000000034',
    '5c331000-0000-4331-8001-000000000035', '5c331000-0000-4331-8001-000000000036', '5c331000-0000-4331-8001-000000000037'
 );
-- Ethereum / WETH — rows into the holding created above
UPDATE holding_transactions SET holding_id = '5c331000-0000-4331-8000-000000000002'
 WHERE id IN (
    '5c331000-0000-4331-8001-000000000038', '5c331000-0000-4331-8001-000000000039', '5c331000-0000-4331-8001-000000000040',
    '5c331000-0000-4331-8001-000000000041', '5c331000-0000-4331-8001-000000000042', '5c331000-0000-4331-8001-000000000043',
    '5c331000-0000-4331-8001-000000000044', '5c331000-0000-4331-8001-000000000045', '5c331000-0000-4331-8001-000000000046',
    '5c331000-0000-4331-8001-000000000047'
 );

-- The 219 surplus copies. Each duplicates an event that keeps exactly one row
-- after the moves above, field for field.
DELETE FROM holding_transactions
 WHERE id IN (
    '5c331000-0000-4331-8002-000000000001', '5c331000-0000-4331-8002-000000000002', '5c331000-0000-4331-8002-000000000003',
    '5c331000-0000-4331-8002-000000000004', '5c331000-0000-4331-8002-000000000005', '5c331000-0000-4331-8002-000000000006',
    '5c331000-0000-4331-8002-000000000007', '5c331000-0000-4331-8002-000000000008', '5c331000-0000-4331-8002-000000000009',
    '5c331000-0000-4331-8002-000000000010', '5c331000-0000-4331-8002-000000000011', '5c331000-0000-4331-8002-000000000012',
    '5c331000-0000-4331-8002-000000000013', '5c331000-0000-4331-8002-000000000014', '5c331000-0000-4331-8002-000000000015',
    '5c331000-0000-4331-8002-000000000016', '5c331000-0000-4331-8002-000000000017', '5c331000-0000-4331-8002-000000000018',
    '5c331000-0000-4331-8002-000000000019', '5c331000-0000-4331-8002-000000000020', '5c331000-0000-4331-8002-000000000021',
    '5c331000-0000-4331-8002-000000000022', '5c331000-0000-4331-8002-000000000023', '5c331000-0000-4331-8002-000000000024',
    '5c331000-0000-4331-8002-000000000025', '5c331000-0000-4331-8002-000000000026', '5c331000-0000-4331-8002-000000000027',
    '5c331000-0000-4331-8002-000000000028', '5c331000-0000-4331-8002-000000000029', '5c331000-0000-4331-8002-000000000030',
    '5c331000-0000-4331-8002-000000000031', '5c331000-0000-4331-8002-000000000032', '5c331000-0000-4331-8002-000000000033',
    '5c331000-0000-4331-8002-000000000034', '5c331000-0000-4331-8002-000000000035', '5c331000-0000-4331-8002-000000000036',
    '5c331000-0000-4331-8002-000000000037', '5c331000-0000-4331-8002-000000000038', '5c331000-0000-4331-8002-000000000039',
    '5c331000-0000-4331-8002-000000000040', '5c331000-0000-4331-8002-000000000041', '5c331000-0000-4331-8002-000000000042',
    '5c331000-0000-4331-8002-000000000043', '5c331000-0000-4331-8002-000000000044', '5c331000-0000-4331-8002-000000000045',
    '5c331000-0000-4331-8002-000000000046', '5c331000-0000-4331-8002-000000000047', '5c331000-0000-4331-8002-000000000048',
    '5c331000-0000-4331-8002-000000000049', '5c331000-0000-4331-8002-000000000050', '5c331000-0000-4331-8002-000000000051',
    '5c331000-0000-4331-8002-000000000052', '5c331000-0000-4331-8002-000000000053', '5c331000-0000-4331-8002-000000000054',
    '5c331000-0000-4331-8002-000000000055', '5c331000-0000-4331-8002-000000000056', '5c331000-0000-4331-8002-000000000057',
    '5c331000-0000-4331-8002-000000000058', '5c331000-0000-4331-8002-000000000059', '5c331000-0000-4331-8002-000000000060',
    '5c331000-0000-4331-8002-000000000061', '5c331000-0000-4331-8002-000000000062', '5c331000-0000-4331-8002-000000000063',
    '5c331000-0000-4331-8002-000000000064', '5c331000-0000-4331-8002-000000000065', '5c331000-0000-4331-8002-000000000066',
    '5c331000-0000-4331-8002-000000000067', '5c331000-0000-4331-8002-000000000068', '5c331000-0000-4331-8002-000000000069',
    '5c331000-0000-4331-8002-000000000070', '5c331000-0000-4331-8002-000000000071', '5c331000-0000-4331-8002-000000000072',
    '5c331000-0000-4331-8002-000000000073', '5c331000-0000-4331-8002-000000000074', '5c331000-0000-4331-8002-000000000075',
    '5c331000-0000-4331-8002-000000000076', '5c331000-0000-4331-8002-000000000077', '5c331000-0000-4331-8002-000000000078',
    '5c331000-0000-4331-8002-000000000079', '5c331000-0000-4331-8002-000000000080', '5c331000-0000-4331-8002-000000000081',
    '5c331000-0000-4331-8002-000000000082', '5c331000-0000-4331-8002-000000000083', '5c331000-0000-4331-8002-000000000084',
    '5c331000-0000-4331-8002-000000000085', '5c331000-0000-4331-8002-000000000086', '5c331000-0000-4331-8002-000000000087',
    '5c331000-0000-4331-8002-000000000088', '5c331000-0000-4331-8002-000000000089', '5c331000-0000-4331-8002-000000000090',
    '5c331000-0000-4331-8002-000000000091', '5c331000-0000-4331-8002-000000000092', '5c331000-0000-4331-8002-000000000093',
    '5c331000-0000-4331-8002-000000000094', '5c331000-0000-4331-8002-000000000095', '5c331000-0000-4331-8002-000000000096',
    '5c331000-0000-4331-8002-000000000097', '5c331000-0000-4331-8002-000000000098', '5c331000-0000-4331-8002-000000000099',
    '5c331000-0000-4331-8002-000000000100', '5c331000-0000-4331-8002-000000000101', '5c331000-0000-4331-8002-000000000102',
    '5c331000-0000-4331-8002-000000000103', '5c331000-0000-4331-8002-000000000104', '5c331000-0000-4331-8002-000000000105',
    '5c331000-0000-4331-8002-000000000106', '5c331000-0000-4331-8002-000000000107', '5c331000-0000-4331-8002-000000000108',
    '5c331000-0000-4331-8002-000000000109', '5c331000-0000-4331-8002-000000000110', '5c331000-0000-4331-8002-000000000111',
    '5c331000-0000-4331-8002-000000000112', '5c331000-0000-4331-8002-000000000113', '5c331000-0000-4331-8002-000000000114',
    '5c331000-0000-4331-8002-000000000115', '5c331000-0000-4331-8002-000000000116', '5c331000-0000-4331-8002-000000000117',
    '5c331000-0000-4331-8002-000000000118', '5c331000-0000-4331-8002-000000000119', '5c331000-0000-4331-8002-000000000120',
    '5c331000-0000-4331-8002-000000000121', '5c331000-0000-4331-8002-000000000122', '5c331000-0000-4331-8002-000000000123',
    '5c331000-0000-4331-8002-000000000124', '5c331000-0000-4331-8002-000000000125', '5c331000-0000-4331-8002-000000000126',
    '5c331000-0000-4331-8002-000000000127', '5c331000-0000-4331-8002-000000000128', '5c331000-0000-4331-8002-000000000129',
    '5c331000-0000-4331-8002-000000000130', '5c331000-0000-4331-8002-000000000131', '5c331000-0000-4331-8002-000000000132',
    '5c331000-0000-4331-8002-000000000133', '5c331000-0000-4331-8002-000000000134', '5c331000-0000-4331-8002-000000000135',
    '5c331000-0000-4331-8002-000000000136', '5c331000-0000-4331-8002-000000000137', '5c331000-0000-4331-8002-000000000138',
    '5c331000-0000-4331-8002-000000000139', '5c331000-0000-4331-8002-000000000140', '5c331000-0000-4331-8002-000000000141',
    '5c331000-0000-4331-8002-000000000142', '5c331000-0000-4331-8002-000000000143', '5c331000-0000-4331-8002-000000000144',
    '5c331000-0000-4331-8002-000000000145', '5c331000-0000-4331-8002-000000000146', '5c331000-0000-4331-8002-000000000147',
    '5c331000-0000-4331-8002-000000000148', '5c331000-0000-4331-8002-000000000149', '5c331000-0000-4331-8002-000000000150',
    '5c331000-0000-4331-8002-000000000151', '5c331000-0000-4331-8002-000000000152', '5c331000-0000-4331-8002-000000000153',
    '5c331000-0000-4331-8002-000000000154', '5c331000-0000-4331-8002-000000000155', '5c331000-0000-4331-8002-000000000156',
    '5c331000-0000-4331-8002-000000000157', '5c331000-0000-4331-8002-000000000158', '5c331000-0000-4331-8002-000000000159',
    '5c331000-0000-4331-8002-000000000160', '5c331000-0000-4331-8002-000000000161', '5c331000-0000-4331-8002-000000000162',
    '5c331000-0000-4331-8002-000000000163', '5c331000-0000-4331-8002-000000000164', '5c331000-0000-4331-8002-000000000165',
    '5c331000-0000-4331-8002-000000000166', '5c331000-0000-4331-8002-000000000167', '5c331000-0000-4331-8002-000000000168',
    '5c331000-0000-4331-8002-000000000169', '5c331000-0000-4331-8002-000000000170', '5c331000-0000-4331-8002-000000000171',
    '5c331000-0000-4331-8002-000000000172', '5c331000-0000-4331-8002-000000000173', '5c331000-0000-4331-8002-000000000174',
    '5c331000-0000-4331-8002-000000000175', '5c331000-0000-4331-8002-000000000176', '5c331000-0000-4331-8002-000000000177',
    '5c331000-0000-4331-8002-000000000178', '5c331000-0000-4331-8002-000000000179', '5c331000-0000-4331-8002-000000000180',
    '5c331000-0000-4331-8002-000000000181', '5c331000-0000-4331-8002-000000000182', '5c331000-0000-4331-8002-000000000183',
    '5c331000-0000-4331-8002-000000000184', '5c331000-0000-4331-8002-000000000185', '5c331000-0000-4331-8002-000000000186',
    '5c331000-0000-4331-8002-000000000187', '5c331000-0000-4331-8002-000000000188', '5c331000-0000-4331-8002-000000000189',
    '5c331000-0000-4331-8002-000000000190', '5c331000-0000-4331-8002-000000000191', '5c331000-0000-4331-8002-000000000192',
    '5c331000-0000-4331-8002-000000000193', '5c331000-0000-4331-8002-000000000194', '5c331000-0000-4331-8002-000000000195',
    '5c331000-0000-4331-8002-000000000196', '5c331000-0000-4331-8002-000000000197', '5c331000-0000-4331-8002-000000000198',
    '5c331000-0000-4331-8002-000000000199', '5c331000-0000-4331-8002-000000000200', '5c331000-0000-4331-8002-000000000201',
    '5c331000-0000-4331-8002-000000000202', '5c331000-0000-4331-8002-000000000203', '5c331000-0000-4331-8002-000000000204',
    '5c331000-0000-4331-8002-000000000205', '5c331000-0000-4331-8002-000000000206', '5c331000-0000-4331-8002-000000000207',
    '5c331000-0000-4331-8002-000000000208', '5c331000-0000-4331-8002-000000000209', '5c331000-0000-4331-8002-000000000210',
    '5c331000-0000-4331-8002-000000000211', '5c331000-0000-4331-8002-000000000212', '5c331000-0000-4331-8002-000000000213',
    '5c331000-0000-4331-8002-000000000214', '5c331000-0000-4331-8002-000000000215', '5c331000-0000-4331-8002-000000000216',
    '5c331000-0000-4331-8002-000000000217', '5c331000-0000-4331-8002-000000000218', '5c331000-0000-4331-8002-000000000219'
 );

-- COVERAGE, half one: the holdings that received rows. `holding_coverage`
-- feeds `CostBasisService` as `historyCompleteness`, and the walk prices a
-- disposal differently when it does not know whether it has the full ledger.
-- The rows moved above ARE the wallet's complete etherscan history for that
-- (account, token) — the import read the whole ledger, it just filed it on the
-- wrong account — so the claim moves with them. Without this the same
-- disposals are valued differently purely because the coverage row stayed
-- behind, which was worth a material spurious WETH gain in the dry run.
INSERT INTO holding_coverage (holding_id, first_tx_at, last_tx_at, tx_sources, has_complete_tx_history)
SELECT ht.holding_id, min(ht.occurred_at), max(ht.occurred_at), ARRAY['etherscan'], true
  FROM holding_transactions ht
 WHERE ht.source = 'etherscan'
   AND ht.holding_id IN (
    '5c331000-0000-4331-8000-000000000008', '5c331000-0000-4331-8000-000000000009', '5c331000-0000-4331-8000-000000000001',
    '5c331000-0000-4331-8000-000000000002'
   )
 GROUP BY ht.holding_id
ON CONFLICT (holding_id) DO UPDATE
   SET first_tx_at = LEAST(holding_coverage.first_tx_at, EXCLUDED.first_tx_at),
       last_tx_at  = GREATEST(holding_coverage.last_tx_at, EXCLUDED.last_tx_at),
       tx_sources  = ARRAY(SELECT DISTINCT unnest(holding_coverage.tx_sources || EXCLUDED.tx_sources)),
       has_complete_tx_history = true,
       updated_at = now();

-- COVERAGE, half two: the holdings that lose every row. These sit on
-- two other own wallets, and each claims a COMPLETE etherscan
-- history. That claim was never true — those wallets' own history was never
-- fetched, because their credential lost the unique (user, institution) slot —
-- and after this migration it stands over an empty ledger. SC-149 made this
-- flag drive cost basis and SC-168 made a failed run retract it; leaving it
-- set here would assert completeness about a ledger nothing ever read. The
-- guard makes this a no-op for any holding that still has rows.
UPDATE holding_coverage
   SET has_complete_tx_history = false,
       updated_at = now()
 WHERE holding_id IN (
    '5c331000-0000-4331-8000-000000000010', '5c331000-0000-4331-8000-000000000011', '5c331000-0000-4331-8000-000000000012',
    '5c331000-0000-4331-8000-000000000013', '5c331000-0000-4331-8000-000000000014', '5c331000-0000-4331-8000-000000000015',
    '5c331000-0000-4331-8000-000000000016', '5c331000-0000-4331-8000-000000000017', '5c331000-0000-4331-8000-000000000018',
    '5c331000-0000-4331-8000-000000000019'
   )
   AND NOT EXISTS (
     SELECT 1 FROM holding_transactions ht
      WHERE ht.holding_id = holding_coverage.holding_id
        AND ht.source = 'etherscan');

-- Postconditions. 281 events in, 281 rows out, each on the wallet that was
-- party to it. Vacuously true on a database that held none of this.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM holding_transactions WHERE source = 'etherscan';
  IF n NOT IN (0, 281) THEN
    RAISE EXCEPTION 'SC-331: expected 281 etherscan rows after repair, found %', n;
  END IF;

  SELECT count(*) INTO n FROM (
    SELECT 1 FROM holding_transactions
     WHERE source = 'etherscan'
     GROUP BY raw_payload->>'hash', token_id, kind
    HAVING count(*) > 1) d;
  IF n <> 0 THEN
    RAISE EXCEPTION 'SC-331: % events still hold more than one row', n;
  END IF;

  SELECT count(*) INTO n
    FROM holding_transactions ht
    JOIN holdings h ON h.id = ht.holding_id
    JOIN accounts a ON a.id = h.account_id
   WHERE ht.source = 'etherscan'
     AND lower(a.metadata->>'walletAddress') IS DISTINCT FROM CASE ht.kind
           WHEN 'transfer_out' THEN lower(ht.raw_payload->>'from')
           ELSE lower(ht.raw_payload->>'to') END;
  IF n <> 0 THEN
    RAISE EXCEPTION 'SC-331: % rows remain on an account that was not party to the transaction', n;
  END IF;
END $$;

COMMIT;
