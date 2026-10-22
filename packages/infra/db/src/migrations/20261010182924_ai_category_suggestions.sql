-- 20261010182924 — AI category suggestions, opt-in per person (SC-1695).
-- users.ai_categories_at: when the person turned them on; NULL is off.
-- transaction_category_ai_answers: what the AI answered for each payee key, so
-- a key is asked once. A NULL category is a remembered "no clear match".
-- Deleting the category deletes its answers, so those keys are asked again.
SET LOCAL lock_timeout = '5s';

ALTER TABLE users ADD COLUMN ai_categories_at timestamptz;

CREATE TABLE transaction_category_ai_answers (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payee_key text NOT NULL,
  category_id uuid REFERENCES transaction_categories(id) ON DELETE CASCADE,
  asked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, payee_key)
);

-- So deleting a category finds its answers without scanning the table.
CREATE INDEX idx_tx_category_ai_answers_category ON transaction_category_ai_answers (category_id);
