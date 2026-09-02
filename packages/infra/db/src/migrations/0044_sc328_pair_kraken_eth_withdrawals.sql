-- SC-328. Eleven Kraken ETH withdrawals are recorded as having left the
-- portfolio. They did not: each one arrived in the user's own Ethereum wallet
-- one to three minutes later, and the arrival is already a row in this table.
--
-- PROVENANCE OF WHAT IS BEING CORRECTED. On 2026-08-14 a raw UPDATE set
-- `transfer_review = 'left_control'` on 560 outflows and wrote no
-- `transfer_reviewed_at`, so nothing records who decided or on what basis
-- (SC-302, SC-324). `left_control` is the one answer that books a disposal.
-- Four other-leg tests in SQL settled 527 of them as genuine; these eleven were
-- among the 33 the tests could not settle, and they are the subset the chain
-- settles outright.
--
-- THE EVIDENCE, per row, measured against production on 2026-08-17.
--
--   * Each outflow is a `withdraw` on the Kraken account carrying no tx hash —
--     Kraken's ledger export records the debit, not the destination.
--   * For each, an ETH `transfer_in` of the SAME quantity to twelve decimal
--     places exists on the owner's Ethereum holding, 1-3 minutes later.
--   * Every one of those arrivals has a `raw_payload.to` that is a wallet in
--     `user_wallets`.
--   * Every one of those arrival transactions was sent by ONE address — a
--     single exchange hot wallet servicing all of them, which is what a CEX withdrawal looks like
--     and what a set of unrelated payments does not.
--   * The amounts are round numbers minus a constant ETH withdrawal fee — that
--     constant is Kraken's fee of the period, and it is also why the ±1%
--     matcher missed the small ones: a fixed fee is a large percentage of a
--     small withdrawal.
--
-- WHY `paired` AND NOT `internal`. The arrival exists as a row, so there is
-- something to point at; `internal` would write a second one. See
-- `TRANSFER_REVIEW_DECISIONS` in `packages/business/shared/src/dtos/transfer-review.ts`.
--
-- WHY `transfer_reviewed_at` STAYS NULL. That column is a positive claim that
-- a person answered through the queue, and it is written in exactly two places,
-- both inside `TransferReviewService`, both behind a session. A migration is
-- not one of them. Leaving it null makes `answerSource` report `unattributed`,
-- which is precisely true: the answer is defensible and it was not given by a
-- human in the queue. Stamping it would repeat the 2026-08-14 mistake in the
-- opposite direction.
--
-- The other 22 unsettled rows are deliberately untouched. Two are chain-proven
-- DEX swaps, where realizing at market is defensible and the real defect is a
-- missing `swap_group_id`. The remaining 20 are outflows booked on wallets that
-- neither sent nor received the transaction — a separate ingester-attribution
-- fault, and no transfer-review answer can be right about a row that should
-- not exist.

-- The prior state, kept rather than described. `TransferReviewService.reopen`
-- can undo an answer, but it cannot know what the answer was before; this can.
CREATE TABLE IF NOT EXISTS "_sc328_kraken_eth_pairs_20260817" (
  "outflow_id"                uuid PRIMARY KEY,
  "inflow_id"                 uuid NOT NULL,
  "group_id"                  uuid NOT NULL,
  "prior_outflow_review"      text,
  "prior_outflow_reviewed_at" timestamp with time zone,
  "prior_outflow_group_id"    uuid,
  "prior_inflow_group_id"     uuid
);

-- Guarded on both legs, so a second run inserts nothing and the two UPDATEs
-- below become no-ops. The outflow must still be an unattributed
-- `left_control`; the inflow must still be an unclaimed ETH `transfer_in` of
-- the same token — the same re-checks `claimInflow` makes, for the same reason.
INSERT INTO "_sc328_kraken_eth_pairs_20260817"
  ("outflow_id", "inflow_id", "group_id", "prior_outflow_review",
   "prior_outflow_reviewed_at", "prior_outflow_group_id", "prior_inflow_group_id")
SELECT p."outflow_id", p."inflow_id", gen_random_uuid(),
       o."transfer_review", o."transfer_reviewed_at", o."transfer_group_id", i."transfer_group_id"
FROM (VALUES
  ('5c328000-0000-4328-8000-000000000001'::uuid, '5c328000-0000-4328-8001-000000000001'::uuid),
  ('5c328000-0000-4328-8000-000000000002'::uuid, '5c328000-0000-4328-8001-000000000002'::uuid),
  ('5c328000-0000-4328-8000-000000000003'::uuid, '5c328000-0000-4328-8001-000000000003'::uuid),
  ('5c328000-0000-4328-8000-000000000004'::uuid, '5c328000-0000-4328-8001-000000000004'::uuid),
  ('5c328000-0000-4328-8000-000000000005'::uuid, '5c328000-0000-4328-8001-000000000005'::uuid),
  ('5c328000-0000-4328-8000-000000000006'::uuid, '5c328000-0000-4328-8001-000000000006'::uuid),
  ('5c328000-0000-4328-8000-000000000007'::uuid, '5c328000-0000-4328-8001-000000000007'::uuid),
  ('5c328000-0000-4328-8000-000000000008'::uuid, '5c328000-0000-4328-8001-000000000008'::uuid),
  ('5c328000-0000-4328-8000-000000000009'::uuid, '5c328000-0000-4328-8001-000000000009'::uuid),
  ('5c328000-0000-4328-8000-000000000010'::uuid, '5c328000-0000-4328-8001-000000000010'::uuid),
  ('5c328000-0000-4328-8000-000000000011'::uuid, '5c328000-0000-4328-8001-000000000011'::uuid)
) AS p("outflow_id", "inflow_id")
JOIN "holding_transactions" o ON o."id" = p."outflow_id"
JOIN "holding_transactions" i ON i."id" = p."inflow_id"
WHERE o."transfer_review" = 'left_control'
  AND o."transfer_reviewed_at" IS NULL
  AND o."transfer_group_id" IS NULL
  AND o."kind" = 'withdraw'
  AND i."kind" = 'transfer_in'
  AND i."transfer_group_id" IS NULL
  AND i."user_id" = o."user_id"
  AND i."token_id" = o."token_id"
  AND abs(abs(i."quantity"::numeric) - abs(o."quantity"::numeric)) < 1e-12
ON CONFLICT ("outflow_id") DO NOTHING;

-- The outflow: answered, and linked to the arrival it was always the other
-- half of. `transfer_review_split` is nulled for the same reason `resolve`
-- nulls it — the two columns must never disagree about what the answer is.
UPDATE "holding_transactions" o
SET "transfer_review" = 'paired',
    "transfer_review_split" = NULL,
    "transfer_group_id" = p."group_id",
    "updated_at" = now()
FROM "_sc328_kraken_eth_pairs_20260817" p
WHERE o."id" = p."outflow_id"
  AND o."transfer_group_id" IS NULL;

-- The inflow: same group id, which is what makes it a pair rather than two
-- rows that happen to agree. `CostBasisService` walks the group, so the Kraken
-- lot now carries into the wallet holding instead of being retired at market
-- there and re-opened at market here.
UPDATE "holding_transactions" i
SET "transfer_group_id" = p."group_id",
    "updated_at" = now()
FROM "_sc328_kraken_eth_pairs_20260817" p
WHERE i."id" = p."inflow_id"
  AND i."transfer_group_id" IS NULL;
