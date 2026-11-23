-- Current-value projection. Old calculator binaries remain valid writers;
-- changing their value inputs invalidates metadata they cannot refresh.
SET LOCAL lock_timeout = '5s';
ALTER TABLE holdings ADD COLUMN value_quote jsonb;

CREATE OR REPLACE FUNCTION holdings_engine_writer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('scani.engine_writer', true), '') <> 'calculator' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.balance::numeric <> 0 OR NEW.value_base IS NOT NULL OR
         NEW.value_priced_at IS NOT NULL OR NEW.value_quote IS NOT NULL THEN
        RAISE EXCEPTION 'holding cache is written only by the engine calculator' USING ERRCODE = 'SCE01';
      END IF;
    ELSE
      IF NEW.balance::numeric IS DISTINCT FROM OLD.balance::numeric OR
         NEW.value_base::numeric IS DISTINCT FROM OLD.value_base::numeric OR
         NEW.value_priced_at IS DISTINCT FROM OLD.value_priced_at OR
         NEW.value_quote IS DISTINCT FROM OLD.value_quote THEN
        RAISE EXCEPTION 'holding cache is written only by the engine calculator' USING ERRCODE = 'SCE01';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.value_quote IS NOT DISTINCT FROM OLD.value_quote AND (
      NEW.balance::numeric IS DISTINCT FROM OLD.balance::numeric OR
      NEW.value_base::numeric IS DISTINCT FROM OLD.value_base::numeric OR
      NEW.value_priced_at IS DISTINCT FROM OLD.value_priced_at OR
      NEW.token_id IS DISTINCT FROM OLD.token_id OR
      NEW.user_id IS DISTINCT FROM OLD.user_id
    ) THEN
      NEW.value_quote := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER holdings_engine_writer_guard
  BEFORE INSERT OR UPDATE OF balance, value_base, value_priced_at, value_quote, token_id, user_id ON holdings
  FOR EACH ROW EXECUTE FUNCTION holdings_engine_writer_guard();
