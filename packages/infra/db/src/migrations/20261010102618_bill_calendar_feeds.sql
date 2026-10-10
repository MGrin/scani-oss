-- 20261010102618 — bill calendar feeds
-- SC-1654: a user's opt-in bills calendar feed. One row means the feed is on;
-- only the SHA-256 of the URL's token is stored. Purely additive.

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS bill_calendar_feeds (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  hashed_token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
