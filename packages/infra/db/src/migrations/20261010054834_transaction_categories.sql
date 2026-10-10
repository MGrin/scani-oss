-- 20261010054834 — transaction categories (SC-1652)
-- A person's categories, one level deep, and the category on each ledger row.
-- Both references carry user_id, so a row can never point at another user's
-- category: tenancy is a key here, not a convention.
SET LOCAL lock_timeout = '5s';

CREATE TABLE transaction_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id uuid,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  color text,
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transaction_categories_id_user_uq UNIQUE (id, user_id),
  -- Deleting a parent lifts its children to the top level; user_id stays.
  CONSTRAINT transaction_categories_parent_fk FOREIGN KEY (parent_id, user_id)
    REFERENCES transaction_categories (id, user_id) ON DELETE SET NULL (parent_id)
);

CREATE UNIQUE INDEX transaction_categories_name_uq ON transaction_categories
  (user_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

-- One level: a parent cannot have a parent, and a category with children
-- cannot become a child.
CREATE FUNCTION transaction_categories_depth() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.parent_id = NEW.id
    OR EXISTS (SELECT 1 FROM transaction_categories p WHERE p.id = NEW.parent_id AND p.parent_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM transaction_categories c WHERE c.parent_id = NEW.id)
  THEN
    RAISE EXCEPTION 'transaction_categories depth: one level of nesting only'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER transaction_categories_depth
  BEFORE INSERT OR UPDATE OF parent_id ON transaction_categories
  FOR EACH ROW EXECUTE FUNCTION transaction_categories_depth();

ALTER TABLE holding_transactions
  ADD COLUMN category_id uuid,
  ADD COLUMN category_set_by text,
  ADD CONSTRAINT holding_tx_category_set_by_check CHECK (
    category_set_by IN ('person', 'import')
    AND category_id IS NOT NULL
    OR category_set_by IS NULL AND category_id IS NULL
  ),
  ADD CONSTRAINT holding_tx_category_fk FOREIGN KEY (category_id, user_id)
    REFERENCES transaction_categories (id, user_id) ON DELETE SET NULL (category_id);

-- The key may only null its own columns, so who set the category is cleared
-- here, as the category is: a row with no category was set by nobody.
CREATE FUNCTION holding_tx_category_set_by_follows() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.category_id IS NULL THEN
    NEW.category_set_by := NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER holding_tx_category_set_by_follows
  BEFORE UPDATE OF category_id ON holding_transactions
  FOR EACH ROW EXECUTE FUNCTION holding_tx_category_set_by_follows();

CREATE INDEX idx_holding_tx_user_category_occurred
  ON holding_transactions (user_id, category_id, occurred_at DESC);
