-- Custom SQL migration file, put your code below! ---- Add mutual fund token type
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
    'mutual-fund',
    'Mutual Fund',
    'Mutual funds and investment funds',
    true,
    6,
    now (),
    now ()
  ) ON CONFLICT (code) DO NOTHING;