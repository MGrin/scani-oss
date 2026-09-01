***REMOVED***
***REMOVED***
***REMOVED***
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
***REMOVED***
-- measured, and the ids can no longer be trusted.
DO $$
DECLARE n integer; bad integer;
BEGIN
  SELECT count(*) INTO n FROM holding_transactions WHERE source = 'etherscan';
  IF n = 0 THEN
    RAISE NOTICE 'SC-331: no etherscan rows here; migration is a no-op';
    RETURN;
  END IF;
  IF n <> 385 THEN
    ***REMOVED***
  END IF;

  SELECT count(*) INTO bad FROM holding_transactions
   WHERE source = 'etherscan'
     AND lower(raw_payload->>'from') IS DISTINCT FROM '***REMOVED***'
     AND lower(raw_payload->>'to')   IS DISTINCT FROM '***REMOVED***';
  IF bad <> 0 THEN
    ***REMOVED***
  END IF;
END $$;


-- The two holdings the moved rows need, created only where the account and
-- token they hang off actually exist — so this inserts nothing on a database
-- without this user's wallets, rather than failing a foreign key.
INSERT INTO holdings (id, user_id, account_id, token_id, balance, source, external_id, is_hidden, is_active, arrival)
SELECT '5c331000-0000-4331-8000-000000000001', '***REMOVED***', '***REMOVED***', '***REMOVED***', '0', 'etherscan', '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', false, true, 'unattributed'
 ***REMOVED***
   AND EXISTS (SELECT 1 FROM tokens   WHERE id = '***REMOVED***')
ON CONFLICT DO NOTHING;  -- Polygon / USDC
INSERT INTO holdings (id, user_id, account_id, token_id, balance, source, external_id, is_hidden, is_active, arrival)
SELECT '5c331000-0000-4331-8000-000000000002', '***REMOVED***', '***REMOVED***', '***REMOVED***', '0', 'etherscan', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', false, true, 'unattributed'
 WHERE EXISTS (SELECT 1 FROM accounts WHERE id = '***REMOVED***')
   ***REMOVED***
ON CONFLICT DO NOTHING;  -- Ethereum / WETH

-- Move the rows whose event has no row at all on the account that made it. Without this they would be deleted as "copies" and the event lost.
-- Ethereum / USDC — rows off an uninvolved account
***REMOVED***
 WHERE id IN (
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    '***REMOVED***'
 );
-- Base / USDC — rows off an uninvolved account
***REMOVED***
 WHERE id IN (
    ***REMOVED***
    ***REMOVED***
 );
-- Polygon / USDC — rows into the holding created above
UPDATE holding_transactions SET holding_id = '5c331000-0000-4331-8000-000000000001'
 WHERE id IN (
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
 );
-- Ethereum / WETH — rows into the holding created above
UPDATE holding_transactions SET holding_id = '5c331000-0000-4331-8000-000000000002'
 WHERE id IN (
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    '***REMOVED***'
 );

-- The 219 surplus copies. Each duplicates an event that keeps exactly one row
-- after the moves above, field for field.
DELETE FROM holding_transactions
 WHERE id IN (
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
 );

-- COVERAGE, half one: the holdings that received rows. `holding_coverage`
-- feeds `CostBasisService` as `historyCompleteness`, and the walk prices a
-- disposal differently when it does not know whether it has the full ledger.
-- The rows moved above ARE the wallet's complete etherscan history for that
-- (account, token) — the import read the whole ledger, it just filed it on the
-- wrong account — so the claim moves with them. Without this the same
-- disposals are valued differently purely because the coverage row stayed
***REMOVED***
INSERT INTO holding_coverage (holding_id, first_tx_at, last_tx_at, tx_sources, has_complete_tx_history)
SELECT ht.holding_id, min(ht.occurred_at), max(ht.occurred_at), ARRAY['etherscan'], true
  FROM holding_transactions ht
 WHERE ht.source = 'etherscan'
   AND ht.holding_id IN (
    ***REMOVED***
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
    ***REMOVED***
    ***REMOVED***
    ***REMOVED***
    '***REMOVED***'
   )
   AND NOT EXISTS (
     SELECT 1 FROM holding_transactions ht
      WHERE ht.holding_id = holding_coverage.holding_id
        AND ht.source = 'etherscan');

***REMOVED***
-- party to it. Vacuously true on a database that held none of this.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM holding_transactions WHERE source = 'etherscan';
  IF n NOT IN (0, 166) THEN
    ***REMOVED***
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
