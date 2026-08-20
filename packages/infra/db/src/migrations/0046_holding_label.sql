-- SC-330. A short user-given name for a position, so an account can hold
-- several rows for one token and the user can tell them apart.
--
***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***
-- nothing to match on but order.
--
-- NULL is the ordinary case and stays the ordinary case: an account with one
-- row for a token needs no name for it. The label only becomes load-bearing
-- when rows collide, where `(account_id, token_id, coalesce(label,''))` is the
-- key the app refuses to duplicate (CreateHoldingsWithDependenciesUseCase).
--
-- No index and no constraint deliberately. Migration 0043's key covers rows an
-- importer addresses; this one is about rows only a human addresses, and the
***REMOVED***
***REMOVED***
ALTER TABLE "holdings" ADD COLUMN IF NOT EXISTS "label" text;
