-- Property and vehicle: valued assets a person prices by hand (SC-1643).
-- They are custom token types, so they inherit the custom-token rules:
-- private to their creator, never priced by a provider, valued by
-- token_prices rows the person writes.
INSERT INTO token_types (code, name, description, is_active, display_order, created_at, updated_at) VALUES
  ('property', 'Property', 'Real estate valued by hand: a home, a flat, land', true, 5, now(), now()),
  ('vehicle',  'Vehicle',  'A car, motorbike or boat valued by hand',          true, 6, now(), now())
ON CONFLICT (code) DO NOTHING;
