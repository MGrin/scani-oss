CREATE INDEX IF NOT EXISTS idx_pvd_user_computed_at
  ON portfolio_value_daily (user_id, computed_at DESC);
