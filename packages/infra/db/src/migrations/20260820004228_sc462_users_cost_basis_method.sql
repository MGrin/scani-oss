-- SC-462. Which matching rule turns this account's transactions into a gain.
--
-- The walk in `CostBasisService` was FIFO and only FIFO, stated in its own
-- comment as an honest simplification. For a UK taxpayer it is not a
-- simplification, it is the wrong answer: HMRC matches a disposal against
-- same-day acquisitions first (TCGA92/S105(1)), then acquisitions in the
-- following 30 days (TCGA92/S106A(5)), and only then against a Section 104
-- pool held at a running average cost. FIFO agrees with none of the three
-- except by coincidence.
--
-- `'fifo'` is the DEFAULT for every existing row and every new one, and that
-- is the whole point of storing it rather than deriving it. Every figure any
-- account has ever read — the chart, `portfolio_value_daily`, both exports,
-- the per-disposal ledger — was computed FIFO. A migration that flipped the
-- rule would move all of them at once with nothing on any screen saying why,
-- which is the failure this ticket is about pointed in the other direction.
-- The number moves when someone chooses to move it, and then it is their
-- change rather than ours.
--
-- Per USER, not per holding and not per jurisdiction. The method is a property
-- of the taxpayer: it is their residence that decides which rulebook their
-- return is filed under, not where any individual coin sat. There is no
-- jurisdiction column anywhere in this schema to key off, and inferring one
-- from an exchange's domicile would be a guess presented as a tax position.
-- A person genuinely filing in two countries needs two computations of the
-- same ledger and gets neither from this column — see
-- docs/features/cost-basis-methods.md.
--
-- Text with a CHECK rather than an enum: adding a method to a pg enum inside a
-- transaction is the one DDL this schema has repeatedly had to work around,
-- and the readers already parse the value at the boundary.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "cost_basis_method" text NOT NULL DEFAULT 'fifo';

ALTER TABLE "users"
  DROP CONSTRAINT IF EXISTS "users_cost_basis_method_check";

ALTER TABLE "users"
  ADD CONSTRAINT "users_cost_basis_method_check"
  CHECK ("cost_basis_method" IN ('fifo', 'uk_section_104'));
