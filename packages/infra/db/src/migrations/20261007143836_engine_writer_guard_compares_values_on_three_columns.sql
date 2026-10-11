-- 20261007143836 — engine writer guard compares values on three columns
-- Foundation A5, PR-1 (decision D-3, operator ruling 2026-10-07). Two changes to
-- the guard A1 created disabled, before A5 enables it:
--
-- 1. It compares `balance` and `value_base` as numbers. Both columns are text,
--    and A1's UPDATE branch compared the text, so rewriting `'10'` as `'10.00'`
--    would have been refused as a write by someone other than the calculator.
--    The same amount in another scale is not a write.
-- 2. It fires only on an UPDATE that names one of the three columns. An UPDATE
--    of any other column never ran a check that could refuse it, so running
--    the function on it was only cost.
--
-- The trigger stays DISABLED: A5's PR-3 enables it.

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
    IF NEW.balance::numeric IS DISTINCT FROM OLD.balance::numeric THEN
      RAISE EXCEPTION 'holdings.balance is written only by the engine calculator' USING ERRCODE = 'SCE01';
    END IF;
    IF NEW.value_base::numeric IS DISTINCT FROM OLD.value_base::numeric THEN
      RAISE EXCEPTION 'holdings.value_base is written only by the engine calculator' USING ERRCODE = 'SCE01';
    END IF;
    IF NEW.value_priced_at IS DISTINCT FROM OLD.value_priced_at THEN
      RAISE EXCEPTION 'holdings.value_priced_at is written only by the engine calculator' USING ERRCODE = 'SCE01';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER holdings_engine_writer_guard
  BEFORE INSERT OR UPDATE OF balance, value_base, value_priced_at ON holdings
  FOR EACH ROW EXECUTE FUNCTION holdings_engine_writer_guard();

ALTER TABLE holdings DISABLE TRIGGER holdings_engine_writer_guard;
