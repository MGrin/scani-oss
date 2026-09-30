-- SC-1409, last step — drop the six `users.observed_burn_*` columns. mgrin
-- decided on 2026-09-28 that they go with the Planning page. #2023 stopped every
-- declaration of them (schema, deletion manifest, tests) and is deployed, so the
-- SC-1097 guard's condition holds: this ships one deploy after the code stopped
-- naming them.
--
-- One production account held a value here and loses it; that was part of the
-- decision. The two CHECK constraints (`users_observed_burn_override_complete`,
-- `users_observed_burn_one_answer`) and both token foreign keys go with their
-- columns.
ALTER TABLE users DROP COLUMN IF EXISTS observed_burn_override;
ALTER TABLE users DROP COLUMN IF EXISTS observed_burn_override_currency_id;
ALTER TABLE users DROP COLUMN IF EXISTS observed_burn_override_at;
ALTER TABLE users DROP COLUMN IF EXISTS observed_burn_confirmed_value;
ALTER TABLE users DROP COLUMN IF EXISTS observed_burn_confirmed_currency_id;
ALTER TABLE users DROP COLUMN IF EXISTS observed_burn_confirmed_at;
