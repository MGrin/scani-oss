CREATE TABLE wealth_planning (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 assumptions jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
