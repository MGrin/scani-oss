-- 20261004001247 — cloud usage events subject nullable
-- Write the SQL here. It runs once, in one transaction,
-- and is identified by this filename forever.

-- SC-1554. Usage rows are the metering record and outlive the account, with no
-- foreign key to it. Deleting an account now clears the two columns that name
-- it (`subject` and `tenant_id`, which a key sets to its owner's id), so
-- `subject` has to admit NULL. The writer never inserts one: the sink drops an
-- event with no subject.
ALTER TABLE cloud_usage_events ALTER COLUMN subject DROP NOT NULL;
