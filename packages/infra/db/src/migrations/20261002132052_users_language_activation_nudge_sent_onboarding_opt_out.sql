-- 20261002132052 — users language, activation nudge sent, onboarding opt-out
-- Write the SQL here. It runs once, in one transaction,
-- and is identified by this filename forever.

-- SC-1503. The first mail a job sends to somebody who has never opened a page
-- since, so their language has to be a property of the account rather than of
-- a request. Recorded from now on only: a guess for existing rows would be a
-- claim nobody made, and NULL already means "English", the letter they get.
ALTER TABLE users ADD COLUMN language text;

-- The nudge is sent once, ever. Claimed BEFORE the send and cleared again if
-- the send fails, so the column is the guarantee on its own.
ALTER TABLE users ADD COLUMN activation_nudge_sent_at timestamptz;

-- A third opt-out stream beside digest and alerts (SC-459). NULL = subscribed.
ALTER TABLE users ADD COLUMN onboarding_opt_out_at timestamptz;
