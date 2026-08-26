-- 20260826054759 — sc661 users observed burn override
--
-- AN OVERRIDE IS NOT A DECLARATION, AND THE DIFFERENCE IS THAT AN OVERRIDE HAS
-- SOMETHING TO DISAGREE WITH.
--
-- That sentence is the whole design and the reason these columns are not named
-- `declared_monthly_spend`. A declaration is a number somebody volunteers into
-- a blank field; an override is a correction applied to a figure the product
-- already computed and already showed them. The first has nothing to be checked
-- against, the second does — and everything below follows from that.
--
-- ## Why the declared version was built, measured, and rejected
--
-- mgrin, 2026-08-26: "On the dashboard it's one number, in money section it's
-- another one ... I feel the best we can do is actually ask a user the average
-- amount he spends per month." A declared-figure headline was built to that
-- instruction and then rejected on a measurement rather than a preference:
-- asked what they spend monthly, people give typical RECURRING spend and omit
-- exceptional items. On his own book that is ~6.3k a month, which yields a
-- 17.8-month runway against an actual drain of 8.1 — a ~2x overstatement, in
-- the flattering direction, which is the exact failure SC-657 exists to avoid.
--
-- His own records show why the estimate would have been low: one obligation is
-- 4.1x his entire committed book and appears nowhere in it. So "committed is 6%
-- of observed" is a fact about what he RECORDS, and a self-reported figure would
-- have omitted precisely what his records omit.
--
-- ## What survives from his instinct, which was right about a real defect
--
-- He objected because the number felt alien, and it IS alien: 76.3% of the
-- observed burn by value rests on `transfer_review` answers carrying no user
-- attribution, and the product currently presents them to him as his own
-- (SC-673). An override gives him authorship of the figure, and an overridden
-- value is a genuinely user-sourced answer — which is what 76% of the current
-- inputs are not. His proposal and the provenance bug turned out to be one
-- insight.
--
-- ## Shape
--
-- `text` and not `numeric`, matching `payments.expected_amount`: money in this
-- schema is a Decimal string and the application's `Decimal.js` is the one
-- authority on how it rounds.
--
-- The CURRENCY is stored beside the amount rather than assuming
-- `base_currency_id`. They agree today for everyone, and a user who later
-- changes base currency would otherwise have their correction silently
-- reinterpreted into a different unit — a wrong runway with no event to notice
-- it by.
--
-- The TIMESTAMP records when the user last stood behind the figure, not when it
-- last differed. Re-affirming the same number in August after setting it in
-- March is new information about March's figure, so a rewrite re-stamps.
--
-- Nothing is backfilled and all three are nullable. Absent means the measured
-- drain answers, which is the design: this corrects a figure, it does not
-- replace the computation that produces one.
ALTER TABLE users
  ADD COLUMN observed_burn_override text,
  ADD COLUMN observed_burn_override_currency_id uuid REFERENCES tokens(id) ON DELETE RESTRICT,
  ADD COLUMN observed_burn_override_at timestamptz;

-- Neither half of the money is meaningful alone: an amount with no currency
-- cannot be converted, and a currency with no amount states nothing. The
-- timestamp travels with them because an override with no date is one the
-- surface cannot say anything honest about — it is the only thing here that
-- goes stale while standing still.
--
-- Enforced in the database rather than only in the DTO because a second write
-- path is how one of them stops being checked.
ALTER TABLE users
  ADD CONSTRAINT users_observed_burn_override_complete
  CHECK (
    (
      observed_burn_override IS NULL
      AND observed_burn_override_currency_id IS NULL
      AND observed_burn_override_at IS NULL
    )
    OR (
      observed_burn_override IS NOT NULL
      AND observed_burn_override_currency_id IS NOT NULL
      AND observed_burn_override_at IS NOT NULL
    )
  );

-- ## The other half: CONFIRMING the measured figure
--
-- Confirming and overriding are the two things the user may do to the drain,
-- and only one of them stores a number the user chose. The confirmation stores
-- one too, and it is easy to mistake for redundant with the live figure — so,
-- explicitly:
--
--   `observed_burn_confirmed_value` IS NOT "the amount he confirmed", kept for
--   the record. It is THE AMOUNT THAT MUST STILL MATCH FOR THE CONFIRMATION TO
--   MEAN ANYTHING.
--
-- The measured drain is recomputed every time the window moves. A confirmation
-- of 8.1 is agreement with 8.1; next month the figure is 11.4 and the same row,
-- read against a bare timestamp, still says he agreed. That is a claim about
-- the present made out of a record of the past. Storing the value makes
-- "confirmed" and "confirmed SOMETHING ELSE" distinguishable, and the second is
-- the state that matters — it is the one where the surface must stop saying he
-- agreed.
--
-- This is the same defect this ticket is fixing, one layer up. `answerSourceOf`
-- infers WHO answered from a timestamp (SC-673); a bare `confirmed_at` would
-- infer WHAT was agreed from a timestamp. Do not ship the shape you are
-- currently repairing.
--
-- **An override needs no such pairing, and that asymmetry is deliberate.** It
-- REPLACES the figure rather than agreeing with it, so there is nothing for it
-- to still match — a stated 6,300 a month is 6,300 whatever the measurement
-- does next. Only agreement can be invalidated by the thing it agreed with
-- moving.
--
-- The currency travels with the confirmed value for the same reason it travels
-- with the override: the drain is computed in the user's base currency, and a
-- later base-currency change would otherwise compare two numbers in different
-- units and call them equal or unequal at random.
ALTER TABLE users
  ADD COLUMN observed_burn_confirmed_value text,
  ADD COLUMN observed_burn_confirmed_currency_id uuid REFERENCES tokens(id) ON DELETE RESTRICT,
  ADD COLUMN observed_burn_confirmed_at timestamptz;

ALTER TABLE users
  ADD CONSTRAINT users_observed_burn_confirmed_complete
  CHECK (
    (
      observed_burn_confirmed_value IS NULL
      AND observed_burn_confirmed_currency_id IS NULL
      AND observed_burn_confirmed_at IS NULL
    )
    OR (
      observed_burn_confirmed_value IS NOT NULL
      AND observed_burn_confirmed_currency_id IS NOT NULL
      AND observed_burn_confirmed_at IS NOT NULL
    )
  );

-- One answer at a time. Agreeing with the measured figure and replacing it are
-- contradictory statements about the same question, and a row holding both
-- gives the surface two authoritative answers to choose between — which is the
-- exact defect this whole ticket started as, moved from two screens into one
-- row.
--
-- Both may be absent: that is the ordinary account, where the measurement
-- answers unchallenged. Enforced here rather than left to the write path
-- because a second write path is how one of them stops being checked, and
-- because the correct sequence — he overrides, the measurement later moves to
-- something he agrees with, he confirms THAT — requires clearing the other, and
-- a constraint is what makes forgetting to a refusal rather than a silent
-- second answer.
ALTER TABLE users
  ADD CONSTRAINT users_observed_burn_one_answer
  CHECK (observed_burn_override IS NULL OR observed_burn_confirmed_value IS NULL);
