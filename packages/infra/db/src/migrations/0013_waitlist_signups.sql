-- Beta-preview waitlist captured by the public landing page.
--
-- See `apps/frontend/landing/src/components/sections/BetaPromise.tsx`
-- for the user-facing flow. Anyone who lands an email here (or creates
-- an account on app.scani.xyz / cloud.scani.xyz) gets grandfathered
-- into 1 year of paid tiers free when subscriptions launch.
--
-- Email is stored lowercased; the unique constraint makes the public
-- waitlist.join procedure idempotent on duplicate signups. We never
-- store the raw IP — only a sha256 hash for per-IP rate-limit auditing.

CREATE TABLE IF NOT EXISTS waitlist_signups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'landing',
  referrer TEXT,
  user_agent TEXT,
  ip_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  converted_to_account_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS waitlist_signups_created_at_idx
  ON waitlist_signups (created_at);
