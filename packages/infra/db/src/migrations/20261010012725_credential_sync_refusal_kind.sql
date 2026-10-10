-- 20261010012725 — credential sync refusal kind
-- The provider's own classification of the last scheduled-sync refusal
-- (ProviderError.kind), so an 'auth-failed' refusal can ask the owner to
-- reconnect instead of reading as a generic stale sync (SC-1686). Null when
-- the last sync succeeded or the failure carried no classification.
ALTER TABLE user_integration_credentials ADD COLUMN sync_refusal_kind text;
