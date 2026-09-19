-- SC-1244. Salt Edge bank connections.
--
-- The institution is seeded with has_integration = false: nothing can link a
-- bank until the connect flow ships, and listing it on the integrations grid
-- before then would offer a button that does nothing. The connect-flow PR
-- flips it.
--
-- `saltedge_customers` maps a Scani user to the one Salt Edge customer made for
-- them. The customer id is also in the user's encrypted credential row, where
-- the provider reads it; this table exists because a signed callback carries
-- only `customer_id`, and an encrypted column cannot be looked up.
--
-- `saltedge_connections` holds one row per linked bank login, keyed by Salt
-- Edge's `connection_id`, kept current from callbacks.
DO $$
DECLARE
    v_bank_type_id uuid;
BEGIN
    SELECT id INTO v_bank_type_id FROM institution_types WHERE code = 'bank';

    INSERT INTO institutions (name, type_id, description, website, logo_url, is_active, has_integration, created_at, updated_at) VALUES
      ('Salt Edge', v_bank_type_id, 'Bank account aggregation across UK and EU banks, plus selected banks in New Zealand and Australia', 'https://www.saltedge.com', NULL, true, false, now(), now())
    ON CONFLICT (website) DO NOTHING;
END $$;

CREATE TABLE IF NOT EXISTS "saltedge_customers" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "customer_id" text NOT NULL UNIQUE,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "saltedge_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "customer_id" text NOT NULL,
  "connection_id" text NOT NULL UNIQUE,
  "status" text NOT NULL,
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_saltedge_connections_user_id" ON "saltedge_connections" ("user_id");
