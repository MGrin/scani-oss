-- SC-339 + SC-352. Two cleanups shipped beside the two writers that produced
-- them, because a delete without its writer is undone by the next hourly sync
-- — and, for Part 1, because the reverse is also true: once the writer is
-- gone nothing will ever rewrite those rows, so leaving them is leaving them
-- forever.
--
-- ─────────────────────────────────────────────────────────────────────────
***REMOVED***
-- ─────────────────────────────────────────────────────────────────────────
--
-- Helius's enhanced API reports one swap THREE times: the wrap/unwrap in
-- `nativeTransfers`, the WSOL and counter-token movements in `tokenTransfers`,
-- and the whole thing again under `events.swap`. `SolanaProvider` emitted a
-- leg from each, so a `-swap-0` / `-swap-1` pair sat on top of transfers that
-- already carried the same lamports.
--
***REMOVED***
***REMOVED***
-- and diffing against the ledger:
--
***REMOVED***
***REMOVED***
***REMOVED***
--     of the 28 is unpartnered.
***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***
--     So where the swap event agreed with the transfers it was redundant, and
--     where it disagreed it was the wrong one of the two.
--   * They were also the worst possible shape to leave in place: `swap_out` is
--     outside the review queue's `kind IN ('withdraw','transfer_out')`
--     predicate, AND `CostBasisService.txValueInBase` refuses the held-token
***REMOVED***
--     realized while nobody could be asked about it.
--
***REMOVED***
***REMOVED***
***REMOVED***
--    re-derives that at run time rather than trusting the measurement. If a
--    row acquired an answer between the measurement and the deploy it is left
--    alone and the postcondition RAISES: an answered swap leg is exactly the
--    thing that must not be removed quietly. Nothing here writes to
--    `transfer_review`, and none of these rows is in either repair set that
***REMOVED***
--
-- NOT FIXED HERE, and the ledger stays wrong until it is: WSOL resolves to the
-- same token identity as native SOL, so a wrap/unwrap round trip records the
***REMOVED***
***REMOVED***
***REMOVED***
-- SC-357 carries the full sweep; it needs a re-derivation of the projection,
-- not a delete, which is why it is not swept in here.
--
-- ─────────────────────────────────────────────────────────────────────────
***REMOVED***
-- ─────────────────────────────────────────────────────────────────────────
--
***REMOVED***
***REMOVED***
***REMOVED***
-- is genuinely a different one:
--
***REMOVED***
***REMOVED***
--     prophylactic, not corrective.
--   * Neither is address poisoning. EVM's poisoning spoofs `from` to the
***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***
--   * The user caused neither and neither moved anything. There is no
--     legitimate zero-value Solana event in the sweep to weigh against them —
***REMOVED***
--
-- Leg numbering counts over the FULL upstream array in both loops, so dropping
-- a leg can never renumber a survivor and no stored `external_id` moves.

BEGIN;

DELETE FROM holding_transactions
 WHERE source = 'solana'
   AND kind IN ('swap_out', 'swap_in')
   AND external_id ~ '-swap-[01]$'
   AND transfer_review IS NULL
   AND transfer_group_id IS NULL
   AND swap_group_id IS NULL;

DELETE FROM holding_transactions
 WHERE source = 'solana'
   AND quantity::numeric = 0
   AND transfer_review IS NULL
   AND transfer_group_id IS NULL;

-- Postconditions. Vacuously true on a database that held none of this.
DO $$
DECLARE n integer;
BEGIN
  -- A swap leg that survives can only be one the predicate spared: it picked
  -- up an answer, a transfer group or a swap group since the measurement.
  -- That is a thing to look at, not a thing to delete, so say so and stop.
  SELECT count(*) INTO n
    FROM holding_transactions
   WHERE source = 'solana' AND kind IN ('swap_out', 'swap_in');
  IF n <> 0 THEN
    RAISE EXCEPTION
      'SC-339: % solana swap-kind row(s) survived — they carry a transfer_review, transfer_group_id or swap_group_id acquired after the measurement; resolve by hand', n;
  END IF;

  SELECT count(*) INTO n
    FROM holding_transactions
   WHERE source = 'solana' AND quantity::numeric = 0;
  IF n <> 0 THEN
    RAISE EXCEPTION 'SC-352: % zero-quantity solana row(s) survived the delete', n;
  END IF;
END $$;

COMMIT;
