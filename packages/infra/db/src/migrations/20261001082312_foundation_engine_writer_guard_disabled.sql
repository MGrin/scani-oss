-- 20261001082312 — foundation engine writer guard disabled
-- Foundation A1, task 3. `holdings.balance`, `value_base` and `value_priced_at`
-- become a cache the engine calculator owns: once plan A5 enables this trigger,
-- a write that changes one of them is refused unless the transaction has set
-- `scani.engine_writer` to `calculator`. A write to any other column is never
-- affected, and neither is one that leaves the three as they were.
--
-- It is created DISABLED, in the same transaction as the function, so no
-- statement ever sees it enabled. A1 changes no behaviour: every writer that
-- moves a balance today still does. A5 turns it on with
--   ALTER TABLE holdings ENABLE TRIGGER holdings_engine_writer_guard
--
-- An insert may create the holding but not fund it: balance 0 and no value.
-- The refusal carries the column it is about, under the SQLSTATE SCE01, so a
-- caller that trips it reads which of the three it wrote.

-- Lock waits are bounded. The runner applies every pending migration in one
-- transaction, so this holds until it commits: a deploy queued behind an open
-- transaction fails with 55P03 and is retried, instead of holding every later
-- query on these tables behind it.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION holdings_engine_writer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('scani.engine_writer', true), '') = 'calculator' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.balance::numeric <> 0 THEN
      RAISE EXCEPTION 'holdings.balance is written only by the engine calculator' USING ERRCODE = 'SCE01';
    END IF;
    IF NEW.value_base IS NOT NULL THEN
      RAISE EXCEPTION 'holdings.value_base is written only by the engine calculator' USING ERRCODE = 'SCE01';
    END IF;
    IF NEW.value_priced_at IS NOT NULL THEN
      RAISE EXCEPTION 'holdings.value_priced_at is written only by the engine calculator' USING ERRCODE = 'SCE01';
    END IF;
  ELSE
    IF NEW.balance IS DISTINCT FROM OLD.balance THEN
      RAISE EXCEPTION 'holdings.balance is written only by the engine calculator' USING ERRCODE = 'SCE01';
    END IF;
    IF NEW.value_base IS DISTINCT FROM OLD.value_base THEN
      RAISE EXCEPTION 'holdings.value_base is written only by the engine calculator' USING ERRCODE = 'SCE01';
    END IF;
    IF NEW.value_priced_at IS DISTINCT FROM OLD.value_priced_at THEN
      RAISE EXCEPTION 'holdings.value_priced_at is written only by the engine calculator' USING ERRCODE = 'SCE01';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER holdings_engine_writer_guard
  BEFORE INSERT OR UPDATE ON holdings
  FOR EACH ROW EXECUTE FUNCTION holdings_engine_writer_guard();

ALTER TABLE holdings DISABLE TRIGGER holdings_engine_writer_guard;
