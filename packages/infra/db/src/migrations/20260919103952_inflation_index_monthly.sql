-- 20260919103952 — inflation index monthly
-- SC-1255. One monthly value per consumer price index series, fetched from
-- BLS nightly for the returns card's inflation line. Not a token price: an
-- index is a rate, and it never converts a value.
CREATE TABLE inflation_index_monthly (
  series_id text NOT NULL,
  month date NOT NULL,
  value numeric NOT NULL,
  source text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (series_id, month),
  CONSTRAINT inflation_index_monthly_first_of_month CHECK (extract(day FROM month) = 1)
);
