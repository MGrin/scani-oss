-- SC-325 / SC-323: one row per externally-addressed position.
--
-- `external_id` is the address an importer dedupes on — the contract
-- `HoldingRepository.findByAccountTokenAndExternalId` has stated since it was
-- written, and the one `findForIngest` restores by preferring NOT NULL rows
-- (SC-193). That lookup takes the first result and assumes there is only one;
-- nothing enforced it. Two rows sharing an address means an importer forked its
-- own position, and every later sync and every ingested transaction then lands
***REMOVED***
***REMOVED***
--
-- PARTIAL, and NOT `NULLS NOT DISTINCT`. Both SC-325's proposed
-- `(account_id, token_id)` and SC-323's `(account_id, token_id, external_id)
***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***
-- keep-newest deletes ~137,000 RUB.
--
-- A row with no external_id is not addressable by any importer, so uniqueness
-- says nothing about it. Whether an account may hold two hand-entered rows for
-- one token is a product policy, and it is already enforced at the only door
-- they come through — `CreateHoldingsWithDependenciesUseCase` refuses the
-- payload (SC-303). Policy in the app, invariant in the database.
--
***REMOVED***
***REMOVED***
-- and deploy, this fails with the offending key named in the error DETAIL,
-- which is the actionable form of the failure.
CREATE UNIQUE INDEX IF NOT EXISTS "holdings_account_token_external_uq"
  ON "holdings" ("account_id", "token_id", "external_id")
  WHERE "external_id" IS NOT NULL;
