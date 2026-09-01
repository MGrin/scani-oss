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
  ('43a7d2a8-f227-4e24-8c17-5028de8449e4'::uuid, 'ccc9ce30-9b14-4799-8983-2c3aade36a37'::uuid),
  ('4692860e-066c-4181-b0e9-bca11347a284'::uuid, '653d01e0-f6e8-46cd-adac-a4fed9edf4aa'::uuid),
  ('92185a26-bd38-4e4d-b438-e77466a84531'::uuid, '1ab52c1f-6dcb-4643-a768-033556078d57'::uuid),
  ('95a820ac-639c-4750-8ea0-bda0b45151b9'::uuid, '59d5be3a-f44b-4c07-b1aa-f6ef737b2ca8'::uuid),
  ('2fe44236-6abe-432c-8200-cf847bdb5366'::uuid, '9b893dea-8092-4916-9b67-d72e2fe7eae7'::uuid),
  ('278c4fe1-ff80-492c-a777-6deb5ab632b1'::uuid, '0bef5f09-9446-4f7d-a4f5-c86c8d2b3178'::uuid),
  ('3e9e3541-0373-4f0d-9d5c-168a4f2186d6'::uuid, 'a45045a4-b000-446d-9d91-b97c2649fe45'::uuid),
  ('8847d2b5-732b-42c7-9d98-897048c47496'::uuid, '06877647-219d-4438-bc0e-4e7313e602f2'::uuid),
  ('3b24ca2c-43aa-49a3-b2ca-d5698a4acd06'::uuid, 'ce33fcb5-b242-4f74-afeb-0693151f7108'::uuid),
  ('3edb2b4b-7f07-480d-bda9-d3e92e6c93e2'::uuid, 'f11402c0-6fa6-428e-91c0-2bff855e8bfd'::uuid),
  ('987f2f14-8723-462c-908c-5c7863916509'::uuid, '0f6a2950-94bb-4df9-82a3-059091cf6b59'::uuid)
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
