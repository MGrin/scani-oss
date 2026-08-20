-- SC-339 + SC-352. Two cleanups shipped beside the two writers that produced
-- them, because a delete without its writer is undone by the next hourly sync
-- — and, for Part 1, because the reverse is also true: once the writer is
-- gone nothing will ever rewrite those rows, so leaving them is leaving them
-- forever.
--
-- ─────────────────────────────────────────────────────────────────────────
-- PART 1 (SC-339) — 28 `solana` rows that restate a movement already recorded.
-- ─────────────────────────────────────────────────────────────────────────
--
-- Helius's enhanced API reports one swap THREE times: the wrap/unwrap in
-- `nativeTransfers`, the WSOL and counter-token movements in `tokenTransfers`,
-- and the whole thing again under `events.swap`. `SolanaProvider` emitted a
-- leg from each, so a `-swap-0` / `-swap-1` pair sat on top of transfers that
-- already carried the same lamports.
--
-- MEASURED read-only against production 2026-08-17, by re-reading the full
-- Helius enhanced history for both Solana wallets (312 transactions, 650 legs)
-- and diffing against the ledger:
--
--   * 28 rows carry a swap kind — 15 `swap_out`, 13 `swap_in`. They span 28
--     DISTINCT signatures with exactly ONE leg each. Not one pair exists, so
--     the "15 out vs 13 in" gap was never two unpartnered outflows: every one
--     of the 28 is unpartnered.
--   * All 28 sit on one wallet whose only holding is SOL. Every counter token
--     is therefore dropped by find-only holding resolution, so under SC-332's
--     rule every group would have orphaned and no `swap_group_id` could ever
--     have been minted for them. Linkage was not available to be added.
--   * 48 of the 51 legs `events.swap` names carry an amount ALREADY emitted by
--     one of the transfer loops for the same signature. The other three are
--     GROSS of the aggregator's platform fee and name a payout the wallet
--     never received — 1.084890643 SOL against 1.075669073 actually credited
--     on NT8nfxwCjgph…, and the same shape on 67VokFy4xicG… and QhUXkbWVP6Hb….
--     So where the swap event agreed with the transfers it was redundant, and
--     where it disagreed it was the wrong one of the two.
--   * They were also the worst possible shape to leave in place: `swap_out` is
--     outside the review queue's `kind IN ('withdraw','transfer_out')`
--     predicate, AND `CostBasisService.txValueInBase` refuses the held-token
--     fallback for swap kinds — so each of the 15 popped its lots at ZERO
--     realized while nobody could be asked about it.
--
-- ►► `transfer_review`: THIS DELETES NOTHING ANYONE ANSWERED. All 28 have
--    `transfer_review IS NULL` and `transfer_group_id IS NULL`, verified on
--    production immediately before this was written, and the predicate below
--    re-derives that at run time rather than trusting the measurement. If a
--    row acquired an answer between the measurement and the deploy it is left
--    alone and the postcondition RAISES: an answered swap leg is exactly the
--    thing that must not be removed quietly. Nothing here writes to
--    `transfer_review`, and none of these rows is in either repair set that
--    was in flight on 2026-08-17 (SC-350 and SC-354 are both `etherscan`).
--
-- NOT FIXED HERE, and the ledger stays wrong until it is: WSOL resolves to the
-- same token identity as native SOL, so a wrap/unwrap round trip records the
-- same lamports twice. 64 of 228 Solana transactions carry the wrong SOL
-- quantity and the net across all of them is +7.849393878 SOL against
-- +2.023918125 on chain. Removing the third copy does not fix the second one.
-- SC-357 carries the full sweep; it needs a re-derivation of the projection,
-- not a delete, which is why it is not swept in here.
--
-- ─────────────────────────────────────────────────────────────────────────
-- PART 2 (SC-352) — 2 `solana` rows that record a movement of zero.
-- ─────────────────────────────────────────────────────────────────────────
--
-- SC-348 established the rule on EVM after re-reading 1071 `tokentx` legs. It
-- did NOT establish it for Solana, and deliberately declined to assume it
-- transferred. The Helius sweep was run before this was written, and the shape
-- is genuinely a different one:
--
--   * 2 zero-amount legs in 650, both native, both inbound, and NO zero-amount
--     token leg exists at all — so the token guard added beside this is
--     prophylactic, not corrective.
--   * Neither is address poisoning. EVM's poisoning spoofs `from` to the
--     victim's OWN address on a real token contract. These two are
--     zero-lamport BROADCAST spam: one System Program transaction fanning ten
--     0-amount transfers to ten unrelated recipients, twice, from two senders
--     (Habp5bnc…, FLiPggWY…) three seconds apart on 2024-03-04, with this
--     wallet as recipient #1 of both. The 0.000005 SOL in Helius's own
--     description is the sender's fee, not a payment.
--   * The user caused neither and neither moved anything. There is no
--     legitimate zero-value Solana event in the sweep to weigh against them —
--     unlike EVM, where the rule took exactly one real `unstake` payout.
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
