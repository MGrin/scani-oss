-- Custom SQL migration file, put your code below! ---- Custom SQL migration file, put your code below! ---- Add mutual fund token type
INSERT INTO
  token_types (
    code,
    name,
    description,
    is_active,
    display_order,
    created_at,
    updated_at
  )
VALUES
  (
    'private-company',
    'Private Company',
    'Private Company, not having a public price available',
    true,
    7,
    now (),
    now ()
  ) ON CONFLICT (code) DO NOTHING;

-- Custom SQL migration file, put your code below! ---- Custom SQL migration file, put your code below! ---- Add mutual fund token type
INSERT INTO
  token_types (
    code,
    name,
    description,
    is_active,
    display_order,
    created_at,
    updated_at
  )
VALUES
  (
    'other',
    'Other',
    'Other type of asset',
    true,
    8,
    now (),
    now ()
  ) ON CONFLICT (code) DO NOTHING;