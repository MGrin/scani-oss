-- SC-515 — where a signup came from, so the demo has a funnel step.

-- SC-507 made the demo the primary CTA on the landing page and shipped no way
-- to tell whether anybody who saw it went on to open an account. The activation
-- funnel is keyed to a row in `users` (see `first_export_at` below this column
-- in the schema), and a demo visitor has no account — so the only place the
-- question can be answered is the account that eventually exists.
--
-- ## What the three values mean, and why NULL is a fourth
--
--   'demo'     the sign-in that created this account carried the demo's tag.
--   'direct'   it did not, on a flow that WOULD have carried one — an observed
--              absence, which is what makes the column able to discriminate
--              rather than always reporting the same thing.
--   'unknown'  the flow that created the account cannot carry a tag at all.
--              Today that is the email-OTP path the installed PWA uses: its
--              sign-in request has no `callbackURL`, so there is nothing for a
--              tag to ride on. Recorded rather than left NULL because "we could
--              not look" and "we looked and there was nothing" are different
--              readings and a funnel that merges them overstates one of them.
--   NULL       the account predates this column. Same reading as
--              `first_export_at`: unknown, not "never".
--
-- ## Why a CHECK rather than an enum
--
-- The value is derived from a query parameter on a URL a stranger's browser
-- supplied, so the boundary is where it has to be refused. A pg enum would need
-- a migration to add a fourth tag; a CHECK states the same closed set and is
-- edited in one place. `cost_basis_method` on this same table is the precedent.
--
-- Nothing is backfilled. Every existing row genuinely predates the instrument,
-- and writing 'unknown' over them would claim the flows were observed.
ALTER TABLE users ADD COLUMN signup_source text;

ALTER TABLE users
  ADD CONSTRAINT users_signup_source_known
  CHECK (signup_source IS NULL OR signup_source IN ('demo', 'direct', 'unknown'));
