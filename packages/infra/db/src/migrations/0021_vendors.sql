CREATE TABLE IF NOT EXISTS vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  normalized_name text NOT NULL,
  category text,
  website text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vendors_user_normalized_unique UNIQUE (user_id, normalized_name)
);

CREATE TABLE IF NOT EXISTS vendor_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  raw_name text NOT NULL,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vendor_aliases_unique UNIQUE (vendor_id, raw_name)
);

CREATE INDEX IF NOT EXISTS idx_vendor_aliases_raw ON vendor_aliases (raw_name);
