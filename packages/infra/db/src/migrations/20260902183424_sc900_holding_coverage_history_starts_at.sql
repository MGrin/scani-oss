-- SC-900 — the earliest date this holding's ledger source COVERS, so a residue
-- the ledger cannot account for can be told apart from a residue nobody can.

-- A holding whose ledger comes from a bounded source — a broker statement over
-- a saved date range, an export that starts mid-history — leaves money that
-- moved before the range with no transaction to record it. Reconciliation sees
-- that as a shortfall and says so, and the sentence it produces is the same one
-- a genuine reconciliation failure produces: money we cannot account for. One
-- of those is worth investigating and the other was settled the moment the
-- window was chosen.
--
-- Nothing in the database could tell them apart, so every audit re-derived it.
--
-- ## Why a column rather than a derivation
--
-- The obvious derivation is the holding's own earliest transaction, and it is
-- wrong: a statement covering a window can REPORT a row dated before that
-- window. A quarterly fee is the ordinary case — reported inside the window,
-- dated to the quarter it accrued in — and it can predate the range by months.
-- Deriving the boundary from `first_tx_at` there announces a window wider than
-- the one that was actually fetched, and prints an explanation over the period
-- between, which nothing fetched. A false explanation over a real gap is
-- strictly worse than the honest "unexplained" it replaces, which is why this
-- is stated by the source rather than inferred from what the source happened
-- to send.
--
-- ## NULL is the default and the safe reading
--
-- NULL means "no source has stated a window for this holding", NOT "the ledger
-- reaches the beginning". Every existing row starts NULL, so no holding is
-- categorised as bounded until something says so, and a provider that says
-- nothing can never manufacture the explanation.
--
-- Written only by a run that also RETRACTED its completeness claim — the bound
-- travels with the retraction rather than on a channel of its own, so a run
-- cannot state how far back it reached while claiming it reached everything.
-- Merged with LEAST, matching `first_tx_at` beside it: the column then means
-- the furthest back any run has ever reached for this holding, so a window
-- that slides FORWARD cannot move the boundary past rows we still hold.
ALTER TABLE holding_coverage
  ADD COLUMN history_starts_at timestamptz;

COMMENT ON COLUMN holding_coverage.history_starts_at IS
  'Earliest date the source of this holding''s ledger covers. NULL = no source has stated one; it does not mean the ledger reaches the beginning (SC-900).';
