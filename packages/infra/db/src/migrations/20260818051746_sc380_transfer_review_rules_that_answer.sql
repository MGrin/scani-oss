-- SC-380. The half of the address-rules feature that WRITES.
--
-- mgrin was asked whether a rule may ever answer `left_control` unattended and
-- said: *"Auto-answer, but only on addresses I explicitly mark."* SC-375
-- shipped the other half and could not do this at all — its verdict vocabulary
-- was `not_a_disposal` and `ask_me`, neither of which writes a
-- `transfer_review`, so no rule could reach the one answer that books a
-- disposal. This migration is what a third verdict, `always_a_disposal`,
-- requires in the schema.
--
-- The cost he accepted, measured in SC-345: at the disposal-or-not level an
-- address rule is right 111 of 116 times, and all five errors assert
-- `left_control` on money that had STAYED — the mistake only ever runs toward
-- a gain he did not make. On the 23-row address that is about one false
-- taxable event per 23 rows. He took that trade for addresses he marks
-- himself, and for no others.
--
-- WHAT REPLACES SC-375's CONTAINMENT
--
-- SC-375's safety argument had two legs and this removes one of them. The
-- rule key is `transfer_counterparty_key(counterparty)`, and counterparty is a
-- field an ATTACKER can write to: address poisoning sprays zero-value
-- `transferFrom` calls on the real USDC contract to plant a lookalike address
-- in a victim's history, and production carries 113 such rows. Slice 1
-- contained that by making no verdict able to assert a disposal. That leg is
-- gone for a marked address, so the remaining containment has to be stated
-- rather than assumed. It is three properties, none of them a check somebody
-- has to remember:
--
--   1. THE KEY IS STILL NEVER TYPED. `TransferReviewRuleService.create` takes
--      a transaction id, not an address, and SELECTs the key off that row
--      under `pendingPredicate` — the caller's own, an outflow, unpaired,
--      unanswered, and NON-ZERO. The zero gate is what excludes the poisoning
--      corpus outright: those rows appear on no screen, so a rule keyed off
--      one could not have been read by anybody. An adversary who reaches the
--      session still cannot mark a destination the user has never sent real
--      money to.
--   2. THE WRITE GATE IS `transfer_review_source IS NULL`, on top of
--      `pendingPredicate`. A rule writes only where nothing has ever been
--      recorded about who decided. That makes "never overwrite an answer
--      stamped `user`" true by construction — a `user` row fails both
--      `transfer_review IS NULL` and this — and it is also what makes the
--      per-row undo below durable rather than a suggestion.
--   3. `pendingPredicate` ALREADY CARRIES THE GROUP-ID GATE. 29 of
--      production's 236 unanswered outflows hold a `transfer_group_id` the
--      matcher wrote; they are invisible to the queue, and `outflowPortions`
--      reads that column BEFORE `isConfirmedDisposal`, so a `left_control`
--      written onto one books nothing while reading as answered (SC-382). The
--      rule engine inherits the gate rather than reimplementing it.
--
-- Marking an address the user's OWN wallet is refused at authoring time, which
-- is the SC-350 refusal moved one level up: ten `left_control` answers on
-- addresses in `user_wallets` booked 10,500 of disposals on money that never
-- left, and a standing rule is that mistake with a repeat count.
ALTER TABLE "holding_transactions"
  ADD COLUMN "transfer_review_rule_id" uuid;

-- WHICH rule answered, not merely that one did.
--
-- `transfer_review_source = 'rule'` alone would be this codebase's own
-- `unattributed` failure re-shipped: a write with no attribution, which cost
-- four separate investigations after the 560-row raw UPDATE of 2026-08-14. And
-- it would be the wrong failure specifically HERE, because the sentence this
-- whole feature exists to preserve is mgrin's about 560 answered transfers —
-- *"I honestly can not remember that anymore anyway."* A row that says "a rule
-- answered this" without naming the rule cannot say "the rule you wrote called
-- this your Bybit deposit address", which is the only part a reader will still
-- understand in three years.
--
-- ON DELETE SET NULL rather than CASCADE or RESTRICT: nothing deletes a rule
-- today (`revoke` sets `revoked_at`, deliberately, so a rule that hid or
-- answered rows stays readable), and if a user is ever deleted the answer on
-- their transfer is still their answer. The CHECK below is what keeps the
-- nulled state honest.
ALTER TABLE "holding_transactions"
  ADD CONSTRAINT "holding_transactions_transfer_review_rule_id_fkey"
  FOREIGN KEY ("transfer_review_rule_id")
  REFERENCES "transfer_review_rules"("id") ON DELETE SET NULL;

-- One invariant, enforced by the database rather than by every writer:
-- a rule id is present exactly when the source says a rule is responsible.
--
-- It matters in the UNDO direction, which is the direction that gets forgotten.
-- Per-row undo leaves `transfer_review NULL` and `transfer_review_source
-- 'user'` — a person overruled the rule on this row — and a rule id surviving
-- that would let the answered list go on naming a rule for an answer that is
-- no longer there. Two columns that must move together, so they are made to.
ALTER TABLE "holding_transactions"
  ADD CONSTRAINT "holding_transactions_transfer_review_rule_attributed"
  CHECK ("transfer_review_rule_id" IS NULL OR "transfer_review_source" = 'rule');

-- The read behind `revoke(withdrawAnswers: true)` and behind every rule's
-- answered count. Partial because the column is NULL on every row in
-- production today and on every row no rule ever touches.
CREATE INDEX "idx_holding_tx_transfer_review_rule"
  ON "holding_transactions" ("transfer_review_rule_id")
  WHERE "transfer_review_rule_id" IS NOT NULL;

-- No backfill, and there is nothing that could be backfilled: no rule has ever
-- answered a row, because until this commit no verdict could. Every existing
-- answer keeps its exact provenance — `user`, `repair`, or the absence that
-- `answerSourceOf` reads as `unattributed`.
