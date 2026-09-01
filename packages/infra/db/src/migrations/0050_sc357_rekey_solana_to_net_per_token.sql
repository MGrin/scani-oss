-- SC-357. The Solana ledger holds several hundred rows describing a couple of
-- hundred transactions, and its net SOL is several times what the wallet has
-- ever held. `SolanaProvider` replayed
-- Helius transfer LEGS, and several of a transaction's legs are the same money
-- seen from different sides: a wrap moves lamports into the wallet's own WSOL
-- account and then moves WSOL out of it, WSOL resolves to the same token
-- identity as native SOL, and both legs were booked. The writer is replaced in
-- the same PR — it now projects `accountData[]`, which states each
-- transaction's NET effect per token once and cannot double count.
--
-- Every `external_id` therefore changes shape, from one-per-leg
-- (`<signature>-native-3`, `<signature>-token-0`) to one-per-token-per-
-- transaction (`<signature>-net-native`, `<signature>-net-<mint>`). Nothing
-- upserts onto the old keys any more, so the old rows would sit beside the new
-- ones forever, and the ledger would then be wrong by that same multiple PLUS
-- a duplicate of itself. They have to go, and this archives them before they
-- do.
--
-- MEASURED read-only, by re-fetching the full Helius enhanced history for the
-- affected Solana wallets and projecting it both ways. The leg replay — which
-- is what today's ledger holds — comes out several times the balance the chain
-- reports. The netted projection from `accountData` lands within a rounding
-- error of what `getBalance` returns: a handful of transaction fees' worth, on
-- transactions Helius's enhanced feed does not return. Around half the
-- signatures carrying SOL have the wrong total today.
--
-- ►► WHOSE ANSWERS THIS DROPS, AND WHY IT IS ALLOWED TO. About half the rows
--    carry a `transfer_review`. NONE is attributable: zero have
--    `transfer_reviewed_at`, zero have `transfer_review_source`. They are part
--    of one untraced bulk UPDATE whose provenance SC-302 and SC-324 both
--    failed to establish — nobody is recorded as having decided any of them.
--    The answers that ARE attributable are all `etherscan`, none is touched
--    here, and the postcondition below re-counts them rather than trusting
--    that. If any Solana row has acquired an ATTRIBUTED answer since the
--    measurement, this migration raises and stops: an answer someone gave is
--    exactly the thing that must not be discarded quietly.
--
-- ►► WHAT THE ARCHIVE IS FOR. `_sc357_solana_rekey_20260817` keeps every
--    deleted row's identity, movement, answer and group, beside the
--    `external_id` its movement is netted into. The mapping is not a guess:
--    the new key is the signature plus `holdings.external_id`, which for a
--    Solana holding is literally `'native'` or the mint — the same two values
--    the provider keys on, written by the same provider's `fetchBalances`. So
--    "which new row absorbed this answer" stays answerable for every archived
--    row. Nearly all of them name a key the re-import will write. The only
--    exceptions are the two legs of one signature — an ATA rent deposit and
--    its refund — whose SOL net is exactly zero: the transaction moved nothing
--    and will have no row.
--
-- ►► THE GROUPED ROWS ARE ARTIFACTS OF THE BUG, AND ARE NOT REPRODUCED.
--    Every transfer group pairs an ATA rent deposit against its own refund, or
--    else a WSOL round trip. Both shapes net to zero inside their transaction
--    under the new projection, so the rows do not survive to be re-paired and
--    the matcher has nothing to match. Most of the groups are worse than
--    redundant: they pair legs from DIFFERENT signatures — a rent credit on
--    one transaction against a rent debit on an unrelated one — which the
--    matcher only did because rent is always the same number. None carries an
--    attributable answer, and none should exist. No `transfer_group_id` is
--    lost that named a real transfer.
--
-- ►► THIS MIGRATION LEAVES THE SOLANA LEDGER EMPTY, AND NOTHING REFILLS IT ON
--    A SCHEDULE. `SyncExchangeTransactionsUseCase` skips `crypto_wallet`
--    institutions outright, so a wallet's transaction history has never been
--    re-imported since its initial wallet import — which is separately why the
--    ledger is missing movements the chain shows, including a stablecoin
--    outflow that emptied a holding while the ledger still reports its
--    pre-outflow balance. The re-import is therefore a REQUIRED step, not a
--    convenience, and it must be run immediately after this deploys, naming
--    the affected holding ids:
--
--        bun scripts/reimport-wallet-transactions.ts --apply <holding-id>…
--
--    It rewrites the ledger from the chain. `holdings.balance` is anchored by
--    the balance sync and not derived from this ledger, so the portfolio's
--    value stays correct throughout; what is empty in between is the history
--    cost basis is built from.
--
-- ►► COVERAGE IS RETRACTED RATHER THAN LEFT LYING. The affected holdings
--    claim `has_complete_tx_history`, and one carries a NEGATIVE opening
--    balance with a note explaining that its history "does not reach far
--    enough back". Both statements are about a ledger that stops existing
--    three statements from here, and the negative opening balance is itself an
--    artifact of the double count. The re-import rewrites all of it.

BEGIN;

-- The prior state, kept rather than described. A `transfer_review` cannot be
-- restored from a row that is gone, and the question SC-302 spent four
-- investigations on — what were those unattributed answers, and what did they
-- attach to — has to stay answerable after this.
CREATE TABLE IF NOT EXISTS "_sc357_solana_rekey_20260817" (
  "id"                     uuid PRIMARY KEY,
  "holding_id"             uuid NOT NULL,
  "token_id"               uuid NOT NULL,
  "kind"                   text NOT NULL,
  "quantity"               text NOT NULL,
  "occurred_at"            timestamp with time zone NOT NULL,
  "old_external_id"        text NOT NULL,
  "new_external_id"        text NOT NULL,
  "transfer_review"        text,
  "transfer_reviewed_at"   timestamp with time zone,
  "transfer_review_source" text,
  "transfer_review_split"  jsonb,
  "transfer_group_id"      uuid,
  "swap_group_id"          uuid
);

-- What the ledger looked like before any of this ran. The scoping
-- postcondition needs a BEFORE to compare against: "some non-solana answer
-- still exists" is not a check — it passes on any database that had one, and
-- is vacuously FALSE on one that had none, which is every fresh database CI
-- builds.
CREATE TEMP TABLE "_sc357_before" ON COMMIT DROP AS
SELECT (SELECT count(*) FROM "holding_transactions") AS "rows",
       (SELECT count(*) FROM "holding_transactions"
         WHERE "source" <> 'solana' AND "transfer_review" IS NOT NULL) AS "other_answers",
       (SELECT count(*) FROM "_sc357_solana_rekey_20260817") AS "archived";

INSERT INTO "_sc357_solana_rekey_20260817"
  ("id", "holding_id", "token_id", "kind", "quantity", "occurred_at",
   "old_external_id", "new_external_id", "transfer_review",
   "transfer_reviewed_at", "transfer_review_source", "transfer_review_split",
   "transfer_group_id", "swap_group_id")
SELECT ht."id", ht."holding_id", ht."token_id", ht."kind", ht."quantity",
       ht."occurred_at", ht."external_id",
       regexp_replace(ht."external_id", '-(native|token)-[0-9]+$', '')
         || '-net-' || h."external_id",
       ht."transfer_review", ht."transfer_reviewed_at",
       ht."transfer_review_source", ht."transfer_review_split",
       ht."transfer_group_id", ht."swap_group_id"
  FROM "holding_transactions" ht
  JOIN "holdings" h ON h."id" = ht."holding_id"
 WHERE ht."source" = 'solana'
ON CONFLICT ("id") DO NOTHING;

DELETE FROM "holding_transactions" WHERE "source" = 'solana';

-- Both claims are about the ledger that just stopped existing. `first_tx_at`,
-- `last_tx_at` and the opening balance are re-derived by the re-import; the
-- completeness claim is re-asserted by it only if it succeeds, which is the
-- same rule `TransactionImportCoordinator.retractCompleteHistoryClaim`
-- applies after a failed import.
UPDATE "holding_coverage" hc
   SET "has_complete_tx_history" = false,
       "first_tx_at" = NULL,
       "last_tx_at" = NULL,
       "opening_balance_quantity" = NULL,
       "reconciliation_notes" = NULL,
       "updated_at" = now()
 WHERE 'solana' = ANY (hc."tx_sources");

DO $$
DECLARE n integer;
BEGIN
  -- An attributed answer is not this migration's to discard. Nothing above
  -- filters on it, so finding one here means the archive is complete and the
  -- delete has run: stop, and let a person look at it before the commit.
  SELECT count(*) INTO n
    FROM "_sc357_solana_rekey_20260817"
   WHERE "transfer_reviewed_at" IS NOT NULL OR "transfer_review_source" IS NOT NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION
      'SC-357: % archived solana row(s) carry an ATTRIBUTED transfer_review — someone answered them after the measurement; resolve by hand', n;
  END IF;

  SELECT count(*) INTO n FROM "holding_transactions" WHERE "source" = 'solana';
  IF n <> 0 THEN
    RAISE EXCEPTION 'SC-357: % solana row(s) survived the delete', n;
  END IF;

  -- Nothing outside `solana` may move. The answers that ARE attributable are
  -- all `etherscan`, and two repairs wrote to that source alongside this one
  -- (SC-350, SC-354), so this re-counts them rather than assuming the WHERE
  -- clause held.
  SELECT count(*) INTO n
    FROM "holding_transactions"
   WHERE "source" <> 'solana' AND "transfer_review" IS NOT NULL;
  IF n <> (SELECT "other_answers" FROM "_sc357_before") THEN
    RAISE EXCEPTION
      'SC-357: non-solana transfer_review count moved from % to % — the delete was not scoped',
      (SELECT "other_answers" FROM "_sc357_before"), n;
  END IF;

  -- Exactly the archived rows left, and nothing else.
  SELECT (SELECT "rows" FROM "_sc357_before") - count(*) INTO n
    FROM "holding_transactions";
  IF n <> (SELECT count(*) FROM "_sc357_solana_rekey_20260817")
            - (SELECT "archived" FROM "_sc357_before") THEN
    RAISE EXCEPTION 'SC-357: % row(s) were deleted, but a different number was archived', n;
  END IF;

  -- An archived row must name a key the new projection could produce. The
  -- shape is the whole reason the mapping is trustworthy.
  SELECT count(*) INTO n
    FROM "_sc357_solana_rekey_20260817"
   WHERE "new_external_id" !~ '-net-[A-Za-z0-9]+$';
  IF n <> 0 THEN
    RAISE EXCEPTION 'SC-357: % archived row(s) mapped to an unparseable new external_id', n;
  END IF;
END $$;

COMMIT;
