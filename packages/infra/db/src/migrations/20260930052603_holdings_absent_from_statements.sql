-- SC-1451. The distinct statement dates a synced holding has been missing
-- from, oldest first. NULL while its source still reports it. Read only for a
-- provider with `absentFiatConfirmations` (IBKR): a currency left out of one
-- Flex CashReport is not a currency that went to zero, so an absence zeroes
-- the holding only after that many consecutive statements. Nullable and
-- unbackfilled: NULL is the correct state for every row that exists today.
ALTER TABLE holdings ADD COLUMN absent_from_statements TIMESTAMPTZ[];
