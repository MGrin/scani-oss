-- Drop write-only observability tables that were never read by any code.
-- sync_failures: only written by wallet sync, never queried. Circuit breaker handles skip logic.
-- client_errors: frontend error reports are now logged as structured JSON instead.

DROP TABLE IF EXISTS "sync_failures";
DROP TABLE IF EXISTS "client_errors";
